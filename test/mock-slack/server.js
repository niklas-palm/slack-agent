// Tiny mock Slack Web API for local agent iteration.
//
// Implements the two endpoints the local happy path uses:
//   GET /api/conversations.replies   → returns a fake thread
//   POST /api/chat.postMessage       → prints what the agent posted
//
// Run with: node test/mock-slack/server.js
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.MOCK_SLACK_PORT ?? 8090);

// Pre-seeded thread the agent will see when it calls get_slack_thread.
// Reset on each container start; that's fine for local iteration.
const thread = [
  { user: 'U_HUMAN', text: 'hey team, what should we use for caching here?', ts: '1700000000.000100' },
  { user: 'U_HUMAN', text: '<@U_BOT> ^ thoughts?', ts: '1700000010.000200' },
];

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/conversations.replies') {
    return send(res, 200, { ok: true, messages: thread });
  }

  if (req.method === 'POST' && path === '/api/chat.postMessage') {
    const raw = await readBody(req);
    let body = {};
    try {
      if (raw) body = JSON.parse(raw);
    } catch {
      return send(res, 400, { ok: false, error: 'body is not valid JSON' });
    }
    // eslint-disable-next-line no-console
    console.log('[mock-slack] chat.postMessage:', JSON.stringify(body, null, 2));
    return send(res, 200, { ok: true, ts: String(Date.now() / 1000), channel: body.channel });
  }

  send(res, 404, { ok: false, error: `unknown method ${req.method} ${path}` });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-slack] listening on :${PORT}`);
});
