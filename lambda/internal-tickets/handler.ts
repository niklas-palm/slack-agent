// Mock internal ticket API - a second OBO downstream target, deliberately
// authorized differently from the directory, and read/write rather than
// read-only.
//
// API Gateway's JWT authorizer has already validated the exchanged token
// (signature, issuer, audience, expiry) and the scope the route requires:
// tickets.read to list, tickets.write to create or modify. So scope handles
// "may this client do this kind of thing".
//
// What is left is "which records are yours", answered by keying every query on
// the token's verified `sub`. No scope or group claim could express that.
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

import { create, list, Status, update } from './tickets.js';

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const subject = String(claims.sub ?? '');

  // Every token that reaches here was minted for a user: the only rules granting
  // tickets.* are on the token-exchange grant. A missing subject would mean
  // something is badly misconfigured, so refuse rather than guess.
  if (!subject) {
    return json(403, { error: 'forbidden', detail: 'this API only serves a signed-in user' });
  }

  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;
  let payload: Record<string, unknown> = {};
  try {
    if (event.body) payload = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'bad_request', detail: 'body is not valid JSON' });
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return json(400, { error: 'bad_request', detail: 'body must be a JSON object' });
  }

  try {
    if (method === 'GET') {
      const tickets = await list(subject);
      return json(200, { authenticated_as: subject, count: tickets.length, tickets });
    }

    if (method === 'POST') {
      const title = String(payload.title ?? '').trim();
      if (!title) return json(400, { error: 'bad_request', detail: 'title is required' });
      const ticket = await create(subject, title);
      return json(201, { authenticated_as: subject, created: ticket });
    }

    if (method === 'PATCH' && id) {
      const status = payload.status as Status | undefined;
      if (status !== undefined && !['open', 'waiting', 'closed'].includes(status)) {
        return json(400, {
          error: 'bad_request',
          detail: 'status must be open, waiting or closed',
        });
      }
      const ticket = await update(subject, id, {
        title: payload.title === undefined ? undefined : String(payload.title),
        status,
      });
      // Someone else's ticket is indistinguishable from one that does not
      // exist, which is what you want: the response leaks nothing.
      if (!ticket) return json(404, { error: 'not_found', detail: `no ticket ${id} of yours` });
      return json(200, { authenticated_as: subject, updated: ticket });
    }

    return json(405, { error: 'method_not_allowed' });
  } catch (e) {
    console.error('ticket request failed', e);
    return json(500, { error: 'internal_error' });
  }
}
