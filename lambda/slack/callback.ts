// The sign-in callback, and where a first-time request resumes.
//
// AgentCore Identity sends the user's browser here after they sign in at Okta:
// GET /oauth2/callback?session_id=... In one pass this claims the parked
// request, completes the token with AgentCore, reads it back out of the vault,
// checks it belongs to this user, and invokes the runtime with it.
//
// This request IS the signal that the human finished, so nothing polls and
// nothing waits while they take their time.
import { CompleteResourceTokenAuthCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
  SESSION_TABLE,
  agentCore,
  brokerOktaToken,
  ddb,
  invokeRuntime,
  say,
  tokenIdentityMatches,
  type PendingRequest,
} from './shared.js';

type Parked = PendingRequest & { expires_at: number };

export async function handler(ev: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const sessionUri = ev.queryStringParameters?.session_id;
  if (!sessionUri) return page(400, 'Missing session', 'No session_id in the callback URL.');
  console.log(`callback: session_id=${sessionUri.slice(-16)}`);

  // Claim the parked request by DELETING it: whoever wins owns the resume, so
  // a double click, a reload or a browser prefetch cannot run the agent twice.
  const claimed = await ddb.send(
    new DeleteCommand({
      TableName: SESSION_TABLE,
      Key: { session_uri: sessionUri },
      ReturnValues: 'ALL_OLD',
    }),
  );
  const pending = claimed.Attributes as Parked | undefined;
  if (!pending) {
    return page(
      410,
      'Already used',
      'This link was already used or expired. Mention the bot again.',
    );
  }

  // DynamoDB's TTL deletes only eventually, so an old row can still be here.
  if (pending.expires_at * 1000 < Date.now()) {
    await say(pending, ':hourglass: That sign-in link expired. Mention me again for a fresh one.');
    return page(410, 'Link expired', 'Head back to Slack and mention the bot again.');
  }

  try {
    await agentCore.send(
      new CompleteResourceTokenAuthCommand({
        sessionUri,
        userIdentifier: { userId: pending.user_id },
      }),
    );
    // The token is in the vault now; the same call the events Lambda makes
    // returns it instead of a sign-in URL.
    const broker = await brokerOktaToken(pending.user_id);
    if (!('token' in broker)) throw new Error('no token in the vault after completing the session');

    if (!tokenIdentityMatches(broker.token, pending.user_id)) {
      console.error(`token subject mismatch for ${pending.user_id} - refusing to invoke`);
      await say(
        pending,
        ":no_entry: The connected account doesn't match your Slack identity. " +
          'Mention me again with "force re-auth" to sign in as yourself.',
      );
      return page(403, 'Wrong account', 'That account does not match your Slack identity.');
    }

    console.log(`callback: resuming the agent for ${pending.user_id}`);
    await say(pending, ':white_check_mark: Thanks, you are connected. Working on it now...');
    await invokeRuntime(broker.token, pending);
    return page(200, 'Connected', 'You can close this tab and return to Slack.');
  } catch (e) {
    // The person is waiting in Slack, not here. The link is spent either way.
    console.error('resume failed', e);
    await say(
      pending,
      ':warning: I could not finish signing you in. Mention me again for a fresh link.',
    );
    return page(500, 'Sign-in failed', 'Head back to Slack and mention the bot again.');
  }
}

function page(statusCode: number, title: string, message: string): APIGatewayProxyResult {
  // Every caller passes a literal, so there is nothing to escape.
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#f1f5f9;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:480px;padding:2rem;text-align:center}
h1{margin:0 0 .5rem;font-size:1.25rem}p{margin:0;opacity:.8}
</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
  return { statusCode, headers: { 'Content-Type': 'text/html' }, body };
}
