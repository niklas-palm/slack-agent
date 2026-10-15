// Shared by the two Slack-facing Lambdas: the events webhook and the sign-in
// callback. Both broker the user's Okta token, both verify it belongs to the
// person who asked, both post into the thread, and both invoke the runtime.
// Keeping those in one place matters most for the identity check, which must
// never drift between the two paths.
import {
  BedrockAgentCoreClient,
  GetResourceOauth2TokenCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Safe here: the Lambda runtime sets AWS_REGION itself. The container and the
// CDK app deliberately take the region from config.json instead.
const REGION = process.env.AWS_REGION!;
const RUNTIME_ARN = process.env.RUNTIME_ARN!;
export const SESSION_TABLE = process.env.SESSION_TABLE!;
export const SIGNING_SECRET_PARAM = process.env.SIGNING_SECRET_PARAM!;
export const BOT_TOKEN_PARAM = process.env.BOT_TOKEN_PARAM!;
// The standalone workload identity user tokens are brokered against. The
// runtime's own workload identity is service-linked and unusable by a plain
// caller, which is why this one exists (see "The sign-in flow" in the README).
const BROKER_WORKLOAD_NAME = process.env.BROKER_WORKLOAD_NAME!;
const USER_PROVIDER = process.env.USER_PROVIDER!;
const USER_SCOPES = process.env.USER_SCOPES!.split(' ');
const OAUTH_CALLBACK_URL = process.env.OAUTH_CALLBACK_URL!;

// AgentCore's authorization session dies after 10 minutes, so a parked request
// must not outlive it.
export const SESSION_TTL_SECONDS = 10 * 60;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
export const agentCore = new BedrockAgentCoreClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

/** Everything needed to run the agent for one mention: the prompt and where to reply. */
export interface PendingRequest {
  /** The Slack-resolved email. Also the userId the vault lookup is keyed on. */
  user_id: string;
  prompt: string;
  channel_id: string;
  thread_ts: string;
  slack_user_id: string;
  trigger_message_ts: string;
}

const params = new Map<string, string>();
export async function loadParam(name: string): Promise<string> {
  const hit = params.get(name);
  if (hit) return hit;
  const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  if (!out.Parameter?.Value) throw new Error(`empty SSM parameter: ${name}`);
  params.set(name, out.Parameter.Value);
  return out.Parameter.Value;
}

// Fail closed. NOT a JWT verifier: never use this shape on a token an attacker
// could supply. It is safe here only because the token came out of the AgentCore
// vault, and the runtime's own authorizer verifies the signature on the way in.
//
// The token must belong to the person who triggered the mention: its `sub` must
// equal the Slack-resolved email. AgentCore files a token under whatever userId
// we assert, so a stale browser session, or a bystander clicking the sign-in
// link, can vault someone else's token under this user. We refuse to act on it.
// Requires the same email in Okta and Slack (OKTA_SETUP.md steps 1 and 3).
export function tokenIdentityMatches(jwt: string, expectedEmail: string): boolean {
  try {
    const part = jwt.split('.')[1];
    if (!part) return false;
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sub?: string };
    const sub = (claims.sub ?? '').toLowerCase();
    return sub !== '' && sub === expectedEmail.toLowerCase();
  } catch {
    return false;
  }
}

// Broker the user's Okta token from outside the runtime. Returns either a token
// from the vault, or a sign-in URL + sessionUri the user has to complete.
//
// Each call WITHOUT a sessionUri that finds no token creates a NEW authorization
// session and invalidates any prior one, so the events Lambda calls this exactly
// once per mention and the callback completes that same session.
export async function brokerOktaToken(
  userId: string,
  forceReauth = false,
): Promise<{ token: string } | { consentUrl: string; sessionUri: string }> {
  const wat = await agentCore.send(
    new GetWorkloadAccessTokenForUserIdCommand({ workloadName: BROKER_WORKLOAD_NAME, userId }),
  );
  if (!wat.workloadAccessToken) throw new Error('no workloadAccessToken from broker');

  const res = await agentCore.send(
    new GetResourceOauth2TokenCommand({
      workloadIdentityToken: wat.workloadAccessToken,
      resourceCredentialProviderName: USER_PROVIDER,
      scopes: USER_SCOPES,
      oauth2Flow: 'USER_FEDERATION',
      resourceOauth2ReturnUrl: OAUTH_CALLBACK_URL,
      // "force re-auth" in the mention: ignore any vaulted token and sign in
      // afresh. Also the only way to clear a mis-bound token, since there is no
      // delete-token API.
      forceAuthentication: forceReauth,
    }),
  );
  if (res.accessToken) return { token: res.accessToken };
  if (res.authorizationUrl && res.sessionUri) {
    return { consentUrl: res.authorizationUrl, sessionUri: res.sessionUri };
  }
  throw new Error('broker returned neither a token nor an authorization session');
}

// Post into the thread, never expanding link previews. That matters for the
// sign-in link: AgentCore's request_uri is single-use, and Slack's preview bot
// would consume it before the human clicks. Best-effort: every caller is
// already on its way out, so a failed post is logged rather than thrown.
export async function postToThread(channel: string, threadTs: string, text: string): Promise<void> {
  try {
    const token = await loadParam(BOT_TOKEN_PARAM);
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    // Slack answers 200 with ok:false on failure, so check the body.
    const body = (await r.json()) as { ok: boolean; error?: string };
    if (!body.ok) throw new Error(body.error ?? 'unknown');
  } catch (e) {
    console.error('slack post failed', e);
  }
}

/** Post into the thread a parked request came from. */
export function say(req: PendingRequest, text: string): Promise<void> {
  return postToThread(req.channel_id, req.thread_ts, text);
}

// Both Lambdas refuse with the same words, so what the user sees is what the
// README's troubleshooting table quotes.
export const IDENTITY_MISMATCH =
  ":no_entry: The connected account doesn't match your Slack identity. " +
  'Mention me again with "force re-auth" to sign in as yourself.';

// Invoke the runtime with the user's Okta token as the Bearer credential. The
// runtime's JWT authorizer validates it, and that is what makes the identity
// proven rather than asserted. A fresh session id per call: one microVM each.
export async function invokeRuntime(jwt: string, req: PendingRequest): Promise<void> {
  const encodedArn = RUNTIME_ARN.replace(/:/g, '%3A').replace(/\//g, '%2F');
  const url = `https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${encodedArn}/invocations?qualifier=DEFAULT`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': globalThis.crypto.randomUUID(),
    },
    body: JSON.stringify({
      prompt: req.prompt,
      slack: {
        channel_id: req.channel_id,
        thread_ts: req.thread_ts,
        slack_user_id: req.slack_user_id,
        trigger_message_ts: req.trigger_message_ts,
      },
    }),
  });
  if (!r.ok) {
    throw new Error(`runtime invoke failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  }
}
