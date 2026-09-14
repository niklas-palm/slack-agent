// The Slack events webhook: an @-mention becomes an agent run.
//
//   1. Verify the Slack signature, answer the URL-verification handshake.
//   2. Resolve the Slack user to an email; that is the identity we broker on.
//   3. Ask AgentCore Identity for the user's Okta token.
//      - Have one: check it is really theirs, invoke the runtime with it.
//      - Don't: park the request, post a sign-in link, and stop. The callback
//        Lambda resumes the parked request when they finish.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
  BOT_TOKEN_PARAM,
  SESSION_TABLE,
  SESSION_TTL_SECONDS,
  SIGNING_SECRET_PARAM,
  brokerOktaToken,
  ddb,
  invokeRuntime,
  loadParam,
  postToThread,
  tokenIdentityMatches,
  type PendingRequest,
} from './shared.js';

interface SlackEvent {
  type?: string;
  text?: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
}

function verifySlackSignature(
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  secret: string,
): boolean {
  if (!signature || !timestamp) return false;
  // Reject requests older than five minutes: replay protection.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected =
    'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The email is the userId the user's Okta identity is keyed on, so a Slack user
// without one cannot be acted for. Requires the users:read.email scope.
async function resolveEmail(slackUserId: string): Promise<string> {
  const token = await loadParam(BOT_TOKEN_PARAM);
  const r = await fetch(
    `https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const j = (await r.json()) as {
    ok: boolean;
    error?: string;
    user?: { profile?: { email?: string } };
  };
  if (!j.ok) throw new Error(`users.info failed for ${slackUserId}: ${j.error ?? 'unknown'}`);
  const email = j.user?.profile?.email;
  if (!email) throw new Error(`no email on Slack user ${slackUserId} (missing users:read.email?)`);
  return email;
}

async function react(channel: string, ts: string, name: string): Promise<void> {
  const token = await loadParam(BOT_TOKEN_PARAM);
  await fetch('https://slack.com/api/reactions.add', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, timestamp: ts, name }),
  });
}

export async function handler(ev: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const headers = Object.fromEntries(
    Object.entries(ev.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const rawBody = ev.isBase64Encoded
    ? Buffer.from(ev.body ?? '', 'base64').toString('utf8')
    : (ev.body ?? '');

  const secret = await loadParam(SIGNING_SECRET_PARAM);
  if (
    !verifySlackSignature(
      headers['x-slack-signature'],
      headers['x-slack-request-timestamp'],
      rawBody,
      secret,
    )
  ) {
    return { statusCode: 401, body: 'invalid signature' };
  }

  let body: { type: string; challenge?: string; event?: SlackEvent };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'not json' };
  }
  if (body.type === 'url_verification') return { statusCode: 200, body: body.challenge ?? '' };
  const event = body.event;
  if (body.type !== 'event_callback' || event?.type !== 'app_mention') {
    return { statusCode: 200, body: 'ok' };
  }

  // Slack retries a delivery it does not see acked within 3s, and marks the
  // retry. Our cold path can exceed 3s, so treat retries as duplicates rather
  // than mint a second authorization session. Trade-off: a mention whose first
  // attempt genuinely failed is dropped. Fine for a sample.
  if (headers['x-slack-retry-num']) return { statusCode: 200, body: 'ok (retry ignored)' };

  const channel = event.channel!;
  const ts = event.ts!;
  // A mention outside a thread starts one on the message itself.
  const threadTs = event.thread_ts ?? ts;
  const text = event.text ?? '';
  const forceReauth = /force re-?auth/i.test(text);

  let email: string;
  try {
    email = await resolveEmail(event.user!);
  } catch (e) {
    console.error('email resolution failed', e);
    await postToThread(
      channel,
      threadTs,
      ":warning: I couldn't look up your email address, so I can't act as you. " +
        'The bot may be missing the `users:read.email` scope.',
    ).catch(() => {});
    return { statusCode: 200, body: 'ok (email unresolved)' };
  }
  console.log(`mention from ${event.user} (${email}) forceReauth=${forceReauth}`);

  // A bare "@bot" with no words is a likely first interaction. The runtime
  // rejects an empty prompt, so answer here rather than leave them waiting.
  const prompt = text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  if (!prompt) {
    await postToThread(channel, threadTs, 'What would you like me to do?').catch(() => {});
    return { statusCode: 200, body: 'ok (empty prompt)' };
  }

  const pending: PendingRequest = {
    user_id: email,
    prompt,
    channel_id: channel,
    thread_ts: threadTs,
    slack_user_id: event.user!,
    trigger_message_ts: ts,
  };

  let broker: Awaited<ReturnType<typeof brokerOktaToken>>;
  try {
    broker = await brokerOktaToken(email, forceReauth);
  } catch (e) {
    console.error('token brokering failed', e);
    await postToThread(
      channel,
      threadTs,
      ":warning: I couldn't reach the identity provider. Please try again shortly.",
    ).catch(() => {});
    return { statusCode: 200, body: 'ok (broker failed)' };
  }

  if ('consentUrl' in broker) {
    console.log(`no vaulted token for ${email} - parking the request, posting a sign-in link`);
    try {
      await ddb.send(
        new PutCommand({
          TableName: SESSION_TABLE,
          Item: {
            session_uri: broker.sessionUri,
            ...pending,
            expires_at: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
          },
        }),
      );
    } catch (e) {
      // Without the row the callback has nothing to resume; do not post a link
      // that leads nowhere.
      console.error('parking the request failed', e);
      await postToThread(
        channel,
        threadTs,
        ":warning: I couldn't start the sign-in. Please mention me again.",
      ).catch(() => {});
      return { statusCode: 200, body: 'ok (park failed)' };
    }

    // SIMPLIFIED FOR THE SAMPLE: the link goes into the thread, where anyone in
    // the channel can click it and sign in as themselves. The identity check
    // refuses to act on the result, so nothing leaks, but the user is left with
    // a mis-bound vault entry and a burned single-use link. Send it out of band
    // in anything real: a DM, a push notification, an email to that one person.
    await postToThread(
      channel,
      threadTs,
      `:lock: First, connect your account so I can act on your behalf:\n` +
        `<${broker.consentUrl}|Sign in to continue>\n\n` +
        "I'll pick up where we left off as soon as you're done.",
    ).catch((e) => console.error('sign-in post failed', e));
    return { statusCode: 200, body: 'ok (sign-in pending)' };
  }

  if (!tokenIdentityMatches(broker.token, email)) {
    console.error(`token subject mismatch for ${email} - refusing to invoke`);
    await postToThread(
      channel,
      threadTs,
      ":no_entry: The connected account doesn't match your Slack identity. " +
        'Mention me again with "force re-auth" to sign in as yourself.',
    ).catch(() => {});
    return { statusCode: 200, body: 'ok (identity mismatch)' };
  }

  // Returning user. An eyes reaction says "seen"; the agent's reply is the answer.
  await react(channel, ts, 'eyes').catch(() => {});
  console.log(`vaulted token for ${email} - invoking the runtime`);
  try {
    await invokeRuntime(broker.token, pending);
  } catch (e) {
    console.error('runtime invoke failed', e);
    await postToThread(
      channel,
      threadTs,
      ':warning: Something went wrong starting your request. Please try again.',
    ).catch(() => {});
  }
  return { statusCode: 200, body: 'ok' };
}
