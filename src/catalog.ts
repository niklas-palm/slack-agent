// The internal APIs this agent may call on the user's behalf, and what to
// request for each one.
//
// Scopes and audience live here, server-side, so the model never chooses them
// and cannot ask for more. Okta caps what the agent's client may ever be minted,
// so this is the request, not the security boundary.
//
// Not filtered per user: the agent may see an API this person cannot use and
// gets a clean 403 at call time. Static for the sample; in production you would
// fetch it from a central registry on boot.
import { INTERNAL_DIRECTORY_URL, INTERNAL_TICKETS_URL } from './config.js';

export interface CatalogEntry {
  /** Path prefix the agent uses: http://127.0.0.1:PORT/<name>/... */
  name: string;
  /** Shown to the agent for discovery. */
  description: string;
  baseUrl: string;
  /** AgentCore Identity OBO credential provider. */
  provider: string;
  /** Downstream audience the token is minted for (per-API). */
  audience: string;
  /** Scopes requested in the exchange. */
  scopes: string[];
}

export const CATALOG: CatalogEntry[] = [
  {
    name: 'directory',
    description:
      "People and org-chart lookups for the company. Read-only. Call GET /directory/me for the signed-in user's own profile.",
    baseUrl: INTERNAL_DIRECTORY_URL,
    provider: 'okta-exchange',
    audience: 'api://internal',
    scopes: ['directory.read'],
  },
  {
    name: 'tickets',
    description:
      'The signed-in user\'s own support tickets. GET /tickets/mine lists them; POST /tickets/mine with {"title": "..."} raises a new one; PATCH /tickets/mine/<id> with {"status": "open|waiting|closed"} or {"title": "..."} changes one of theirs.',
    baseUrl: INTERNAL_TICKETS_URL,
    provider: 'okta-exchange',
    audience: 'api://internal',
    scopes: ['tickets.read', 'tickets.write'],
  },
];
