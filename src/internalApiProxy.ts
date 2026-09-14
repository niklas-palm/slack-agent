// A loopback proxy that lets the agent call internal, Okta-protected APIs on
// behalf of the Slack user, without ever seeing a token.
//
// The agent's own code (Python, curl, whatever it writes) calls
//   <method> http://127.0.0.1:<port>/<api>/<path>
// with NO credentials. This proxy looks the API up in a static catalog, does
// an On-Behalf-Of token exchange with AgentCore Identity (the runtime already
// holds the user's proven identity), forwards the request to the real API with
// the minted token, and returns the response. The token lives only here, in
// the harness process, never in the model's context and never in the sandbox.
//
// One microVM per user (per Slack @-mention), so a single captured workload
// token and a loopback bind are safe.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { withAccessToken } from 'bedrock-agentcore/identity';

import { CATALOG, type CatalogEntry } from './catalog.js';
import { emit, errMsg } from './emit.js';

// Also hard-coded in the system prompt (src/prompt.ts) and the README, so a
// change here means changing all three.
const PORT = 8899;
const PROXY_URL = `http://127.0.0.1:${PORT}`;

// The current invocation's workload access token (carries the user's proven
// identity). Set by the server when a request arrives; one user per microVM.
let workloadToken: string | undefined;
export function setWorkloadToken(token: string | undefined): void {
  workloadToken = token;
}

// Forward one request to the real API, acting as the user. withAccessToken does
// the OBO exchange with AgentCore Identity and injects the minted token as the
// last argument; the token never leaves this function.
//
// Note what is NOT passed: the user's Okta token. We authenticate as the
// workload access token, and AgentCore Identity substitutes the user's own token
// (the one its authorizer validated on the way in) as the subject of the
// exchange. That is why the harness never handles the raw user JWT. Okta needs two
// things AgentCore doesn't send by default - a subject-token-type of
// access_token and the per-API audience - so we pass them in customParameters.
async function forwardAsUser(
  entry: CatalogEntry,
  userToken: string,
  target: string,
  method: string,
  body?: string,
) {
  // Which step failed matters: Okta refusing the exchange is a permanent
  // answer about this user, while a failure afterwards is the network or the
  // API itself. The callback only runs once a token has been minted.
  let exchanged = false;
  const call = withAccessToken({
    workloadIdentityToken: userToken,
    providerName: entry.provider,
    scopes: entry.scopes,
    authFlow: 'ON_BEHALF_OF_TOKEN_EXCHANGE',
    customParameters: {
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: entry.audience,
    },
  })(async (token: string) => {
    exchanged = true;
    return fetch(target, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
  });
  try {
    return await call();
  } catch (e) {
    throw Object.assign(new Error(errMsg(e)), { stage: exchanged ? 'forward' : 'exchange' });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  // The response may already be streaming if a later step threw. Writing the
  // head twice throws inside a rejection handler and takes the process down.
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', PROXY_URL);
  const segments = url.pathname.split('/').filter(Boolean);

  // GET / -> discovery: the APIs the agent may call, names and descriptions only.
  if (segments.length === 0) {
    return send(res, 200, {
      apis: CATALOG.map((e) => ({ name: e.name, description: e.description })),
    });
  }

  const [apiName, ...rest] = segments;
  const entry = CATALOG.find((e) => e.name === apiName);
  if (!entry) {
    return send(res, 404, {
      error: `unknown api '${apiName}'`,
      hint: `GET ${PROXY_URL}/ to list available apis`,
    });
  }
  if (!workloadToken) {
    return send(res, 401, {
      error: 'no proven user identity for this invocation',
      hint: 'this only works inside a real Slack-triggered invocation carrying the user JWT',
    });
  }

  try {
    const target = `${entry.baseUrl}/${rest.join('/')}${url.search}`;
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const upstream = await forwardAsUser(entry, workloadToken, target, req.method ?? 'GET', body);
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(text);
  } catch (e) {
    // A refused exchange means this user isn't authorized for this api, so 403:
    // that is what the system prompt tells the agent not to retry. Anything
    // that failed after the token was minted is reported as 502 instead.
    // Only a refused exchange is an authorization answer. Everything else,
    // including anything thrown outside forwardAsUser, is reported as transient
    // so the agent does not tell the user they lack access after a network blip.
    const refused = (e as { stage?: string }).stage === 'exchange';
    send(res, refused ? 403 : 502, {
      error: errMsg(e),
      hint: refused
        ? 'the token exchange failed; usually the user is not authorized for this api'
        : 'the api call failed after the token was minted; this may be transient',
    });
  }
}

export function startInternalApiProxy(): void {
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: errMsg(e) }));
  });
  // Loopback only: nothing outside the microVM can reach it.
  server.listen(PORT, '127.0.0.1', () => emit('internal_api_proxy_ready', { url: PROXY_URL }));
}
