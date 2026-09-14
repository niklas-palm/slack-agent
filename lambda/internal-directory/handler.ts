// Mock internal directory API: one of the two OBO downstream targets.
//
// By the time this runs, API Gateway's JWT authorizer has validated the
// exchanged token (signature, issuer, audience, expiry) and the scope the route
// requires. What is left is the one decision the identity provider will not make
// for us: is this person allowed to read the directory. Okta does not evaluate
// a rule's group condition on the token-exchange grant, so the answer comes from
// the `groups` claim Okta signed into the token, and this API enforces it.
//
// `sub` is the user the agent is acting for, not the agent. That is the point
// of the endpoint: it echoes who called, according to the token.
//
// PATCH /me requires directory.write. No Okta rule grants that on the exchange
// grant, so the agent is refused before reaching here. The route exists to show
// the ceiling, which is why the profile is canned and nothing is stored.
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

const REQUIRED_GROUP = process.env.REQUIRED_GROUP!;

const PROFILE = {
  title: 'Member of Technical Staff',
  department: 'Engineering',
  office: 'Stockholm',
};

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// API Gateway flattens the groups claim to the string "[a, b]". An absent claim
// yields [], which fails the check: fail closed.
function groupsFrom(claim: unknown): string[] {
  return String(claim ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const subject = String(claims.sub ?? 'unknown');
  const groups = groupsFrom(claims.groups);

  if (!groups.includes(REQUIRED_GROUP)) {
    console.log(`denied ${subject}: groups=[${groups.join(', ')}] lacks ${REQUIRED_GROUP}`);
    return json(403, {
      error: 'forbidden',
      detail: `reading the directory requires membership of "${REQUIRED_GROUP}"`,
    });
  }

  if (event.requestContext.http.method === 'PATCH') {
    let body: Partial<typeof PROFILE> = {};
    try {
      if (event.body) body = JSON.parse(event.body);
    } catch {
      return json(400, { error: 'bad_request', detail: 'body is not valid JSON' });
    }
    return json(200, { authenticated_as: subject, updated: { ...PROFILE, ...body } });
  }

  return json(200, {
    message: 'internal directory profile (returned on the user behalf via OBO)',
    authenticated_as: subject,
    profile: PROFILE,
  });
}
