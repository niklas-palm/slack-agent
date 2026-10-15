# Identity provider setup

This sample lets an agent call an internal API **as the person who asked it to**.
That needs an identity provider. This document explains what the provider has to
do, then walks the Okta console. The click paths are Okta's, but the four roles
below are what matter: swap the click path and the same design works on Entra,
Auth0, Keycloak or Cognito.

Read it in that order too. Steps 1 and 2 are just an org: people, groups, and the
API surface they already have. The agent only arrives in step 3, as one more
client users can delegate to, inheriting a subset of what each user already had.

Everything is done in the Okta admin console. No admin API token, no scripts.

---

## The four roles any identity provider must fill

1. **A directory with groups.** Where people exist and where you say who is what.
   Access is expressed as group membership and nothing else.
2. **An authorization server.** Issues tokens. It has an OIDC discovery URL, an
   **audience** naming the resource it protects, and **scopes** standing for
   permissions.
3. **A sign-in client** using the authorization-code grant. This is what the user
   logs in to, and it produces the token that proves who they are.
4. **An exchange client** using the token-exchange grant. This swaps the user's
   token for one scoped to a downstream API, without the user present.

Three and four are separate registrations because a grant type is tied to a
client. One walks a human through a login screen; the other runs with no human at
all.

---

## What you will create

These names are in the code, so use them as-is or change both sides:

| Thing | Value | Meaning |
| --- | --- | --- |
| Audience | `api://internal` | The name every token must be minted for. |
| Scope | `agent.invoke` | Requested at sign-in. |
| Scope | `directory.read` | Read the people directory. |
| Scope | `directory.write` | Change a profile. Defined, granted to no exchange rule. |
| Scope | `tickets.read` / `tickets.write` | Read and raise your own support tickets. |
| Group | `employees` | The group the directory API requires. |
| Credential providers | `okta-signin`, `okta-exchange` | Hold each app's secret in AgentCore Identity. |

These are yours to name; nothing in the code refers to them:

| Thing | Value in this sample | Meaning |
| --- | --- | --- |
| Authorization server | `internal-apis` | The org's internal API surface. |
| Group | `contractors` | A second group, so you can show a denial. Must match the claim regex below. |
| Sign-in app | `slack-agent` | Users log in here. |
| Exchange app | `agent-exchange` | Performs the on-behalf-of exchange. Not Slack-specific. |

You need an **Okta Integrator** org, which is free: sign up at
[developer.okta.com](https://developer.okta.com/signup/). A Workforce Identity org
will not work, because it lacks the token exchange (on-behalf-of) grant this
sample depends on. Its console also looks different, so the click paths below
won't match.

---

## Step 1 - groups and people

**Directory > Groups > Add group.** Create two, because access has to be
expressible as membership:

- `employees` - full-time staff, may read internal systems
- `contractors` - external, may use internal tools but not read the directory

Then add yourself to `employees`: **Directory > Groups > employees > People >
Assign people.** Your Okta user's email must be the same address as your Slack
profile email, because that is how the bot matches you. A second user in
`contractors` is optional; the check at the end moves your own account instead.

---

## Step 2 - the authorization server

**Security > API > Authorization Servers > Add Authorization Server.**

| Field | Value |
| --- | --- |
| Name | `internal-apis` |
| Audience | `api://internal` |
| Description | The org's internal APIs |

Note the **Issuer** it shows, e.g.
`https://integrator-1234567.okta.com/oauth2/aus1a2b3c4d5e6f7g8h9`. Keep it; step 5
uses it. Its two parts go into config now: the hostname is `okta.domain` (no
`https://`), and the last path segment is `okta.authorizationServerId`. Either
edit `config.json`, or leave that tracked file alone and create an untracked
`config.local.json` in the repo root:

```json
{ "okta": { "domain": "integrator-1234567.okta.com", "authorizationServerId": "aus1a2b3c4d5e6f7g8h9" } }
```

**An authorization server takes exactly one audience.** The `audience` on an
exchange must match it or you get `invalid_target`. Both APIs here share this one
and are told apart by scope.

Then, on the same server:

**Settings tab > Issuer.** If you have a custom domain and there is a choice,
pick **Okta URL**: AgentCore validates `iss` against the issuer the CDK builds
from `okta.domain`, so the two must be the same hostname. Without a custom domain
there is only one URL, and nothing to set.

**Scopes tab > Add Scope**, five times. Name them `resource.action`, leave user
consent **Implicit**:

| Name | Description |
| --- | --- |
| `agent.invoke` | Requested at sign-in. Nothing verifies it; its job is to make the sign-in rule match |
| `directory.read` | Read the internal people directory |
| `directory.write` | Update a directory profile |
| `tickets.read` | Read your own support tickets |
| `tickets.write` | Create and modify your own support tickets |

A scope is just a name until a policy rule grants it and an API checks it.

**Claims tab > Add Claim.** The resource server needs to know which groups the
caller is in, because Okta will not enforce that on an exchange (see
[what Okta enforces](#what-okta-enforces-and-what-it-does-not)):

| Field | Value |
| --- | --- |
| Name | `groups` |
| Include in token type | Access token |
| Value type | Groups |
| Filter | Matches regex, with the value below |
| Include in | Any scope |

```
^(employees|contractors)$
```

The regex keeps Okta's built-in `Everyone` out of the token. This claim is
evaluated when the token is minted, including on an exchange, so moving someone
between groups takes effect on their next request.

---

## Step 3 - the sign-in app

**Applications > Create App Integration > OIDC - OpenID Connect > Web
Application.**

| Field | Value |
| --- | --- |
| App integration name | `slack-agent` |
| Grant type | Authorization Code **and** Refresh Token |
| Sign-in redirect URIs | `https://example.invalid/placeholder` for now |
| Controlled access | Limit access to selected groups: `employees` and `contractors` |

The redirect URI is a placeholder because the real one is **AgentCore Identity's
own callback**, which does not exist until step 5. You will come back.

Then two settings on the app that are easy to miss:

**Sign On tab > Application username format > Email.** The token's `sub` is the
app username, and the sample matches it against the Slack user's email. Okta's
default, "Okta username", also works when usernames are emails, which they are
unless you changed them; setting Email makes it explicit. Get it wrong and Slack
shows ":no_entry: The connected account doesn't match your Slack identity" even
though the right person signed in.

**General tab > Client Credentials.** Client authentication stays **Client
secret**.

Copy the **Client ID** and **Client secret** from the General tab; you need both
in step 5. They stay visible under General > Client Credentials if you lose
them.

---

## Step 4 - the exchange app

**Applications > Create App Integration > API Services.** Name it
`agent-exchange`.

Then, on the **General** tab, click **Edit** on General Settings, tick **Token
Exchange** under Grant type, and **Save**.

Three things worth knowing:

- **Client Credentials stays ticked.** Okta will not create an API Services app
  without it. That is fine as long as you never grant this app a scope on the
  client-credentials grant, which is what keeps it unable to mint a token with no
  user involved. The policy in step 6 grants it only on token exchange.
- **Client authentication stays Client secret.** An API Services app can be set
  to public-key/private-key JWT instead, and then there is no secret for step 5
  to store.
- **Leave DPoP off on both apps.** It is off by default. AgentCore sends no
  proof, so a DPoP-required client fails with `invalid_dpop_proof`.

Copy this app's **Client ID** and **Client secret** too.

---

## Step 5 - AgentCore Identity credential providers

These hold each app's id and secret so AgentCore can act as that client, which
is why no secret appears in the agent's code or configuration.

This step is AWS, not Okta, and it is the one place a command beats the console:
the vendor and the token-exchange block have to be exact. Run it from the repo
root so the region comes from your config.

```bash
REGION=$(make -s region)
ISSUER=<the Issuer from step 2, e.g. https://integrator-1234567.okta.com/oauth2/aus1a2b3c4d5e6f7g8h9>

# Sign-in. The vendor matters: OktaOauth2 with explicit endpoints, NOT
# CustomOauth2 with a discovery URL. See the gotchas - the generic provider
# fails silently for this flow.
aws bedrock-agentcore-control create-oauth2-credential-provider --region "$REGION" --cli-input-json '{
  "name": "okta-signin",
  "credentialProviderVendor": "OktaOauth2",
  "oauth2ProviderConfigInput": {"includedOauth2ProviderConfig": {
    "clientId": "<sign-in-client-id>", "clientSecret": "<sign-in-client-secret>",
    "issuer": "'"$ISSUER"'",
    "authorizationEndpoint": "'"$ISSUER/v1/authorize"'",
    "tokenEndpoint": "'"$ISSUER/v1/token"'"}}}'

# On-behalf-of. This one stays CustomOauth2: it needs the token-exchange block.
aws bedrock-agentcore-control create-oauth2-credential-provider --region "$REGION" --cli-input-json '{
  "name": "okta-exchange",
  "credentialProviderVendor": "CustomOauth2",
  "oauth2ProviderConfigInput": {"customOauth2ProviderConfig": {
    "oauthDiscovery": {"discoveryUrl": "'"$ISSUER/.well-known/openid-configuration"'"},
    "clientId": "<exchange-client-id>", "clientSecret": "<exchange-client-secret>",
    "clientAuthenticationMethod": "CLIENT_SECRET_BASIC",
    "onBehalfOfTokenExchangeConfig": {"grantType": "TOKEN_EXCHANGE",
      "tokenExchangeGrantTypeConfig": {"actorTokenContent": "NONE"}}}}}'
```

Each call returns a `callbackUrl` unique to that provider. Take the **sign-in**
provider's callback (lost it? `aws bedrock-agentcore-control
get-oauth2-credential-provider --region "$REGION" --name okta-signin --query
callbackUrl --output text`):

```
https://bedrock-agentcore.<region>.amazonaws.com/identities/oauth2/callback/<uuid>
```

Go back to **Applications > slack-agent > General > Sign-in redirect URIs** and
make that the only entry, replacing the placeholder from step 3.

This is the step people get wrong. The redirect URI is AgentCore's callback, not
your application's. AgentCore drives the sign-in and redirects back to itself.
Your own callback URL is the `resourceOauth2ReturnUrl`, which the CDK registers
on the **workload identity**, and it must not appear in Okta's redirect list.

---

## Step 6 - the access policy

**Security > API > Authorization Servers > internal-apis > Access Policies.**
This is the rulebook: which client may obtain which scopes, by which grant.

**Check what is already there first.** If this tab already lists a policy,
especially one whose rule allows all scopes for all clients, delete or deactivate
it. Okta uses the **first** policy whose conditions match, so an allow-all policy
above yours would answer every request and hand the agent `directory.write`.

Then **Add Policy**:

| Field | Value |
| --- | --- |
| Name | `internal-apis-access` |
| Description | Which clients may obtain which scopes |
| Assign to | The two apps: `slack-agent` and `agent-exchange` |

Then **Add Rule** three times. Leave the token lifetimes at their defaults unless
you want a shorter access token while testing.

**Rule 1, `sign-in-to-agent`.** This gates the user, and here the group condition
**is** enforced:

| Condition | Value |
| --- | --- |
| Grant type | Authorization Code |
| User is | The groups `employees` and `contractors` |
| Scopes requested | `agent.invoke`, `openid`, `offline_access` |

**Rule 2, `exchange-for-directory-read`.** Note there is deliberately no group
condition, because Okta would ignore it on this grant:

| Condition | Value |
| --- | --- |
| Grant type | Token Exchange |
| User is | Any user assigned the app |
| Scopes requested | `directory.read` |

**Rule 3, `exchange-for-tickets`.** Same shape, granting both ticket scopes
together because the agent needs both:

| Condition | Value |
| --- | --- |
| Grant type | Token Exchange |
| User is | Any user assigned the app |
| Scopes requested | `tickets.read`, `tickets.write` |

Three things follow from how Okta evaluates this:

- **A request must be satisfied by a single matching rule.** That gives least
  privilege by default: asking for two scopes at once fails with `access_denied`
  unless one rule grants them together. Rule 3 does, on purpose.
- **`offline_access` is how you get a refresh token.** `refresh_token` is not a
  grant type you can put in a rule condition. Rule 1 grants the scope and the
  sample requests it, so one sign-in outlives the access token.
- **Onboarding an API is one scope and one rule.** The ticket API was added
  exactly that way, plus a route that requires the scope and an entry in
  `src/catalog.ts`.

`directory.write` shows the other half of the ceiling. It exists on the server and
the directory API has a `PATCH /me` route that requires it, so a person could use
it. No rule grants it on token exchange, so the agent cannot get it: asking is
refused at Okta before any API is reached.

```
agent's exchange client asks for  directory.read                 -> minted
                                 tickets.read tickets.write      -> minted
                                 directory.write                 -> access_denied
                                 directory.read directory.write  -> access_denied
```

---

## What Okta enforces, and what it does not

This is the part worth understanding before you trust the setup.

**Enforced on an exchange:** which client may ask, the grant type, and the
requested scopes. A scope named in no rule is refused with `access_denied`; an
undefined scope with `invalid_scope`; a mismatched audience with
`invalid_target`. So the policy is a real ceiling on what a compromised agent
could ever request.

**Not enforced on an exchange:** the subject user's group membership. A rule's
user condition is ignored for the token-exchange grant. Verified by putting the
group condition on both rules, signing in while still in `employees` to get a
subject token, then moving the account to `contractors` only. From that point a
fresh sign-in was refused with "Policy evaluation failed", while exchanging the
subject token still succeeded and returned `directory.read`. Okta Developer
Support has confirmed on their forum that for on-behalf-of exchange "evaluations
that usually happening during the authorize call won't happen", and Okta's own
engineering blog demonstrates the resulting privilege escalation.

**So the split is:**

| Decision | Where it lives |
| --- | --- |
| May this user use the agent at all | Okta, sign-in rule + app assignment |
| What may this agent ever request | Okta, exchange rule scopes |
| May this user read this API | **The resource server**, from the `groups` claim |

That last row is not a workaround: it is where OAuth puts user authorization.
Okta remains the source of truth, asserting the membership in a signed claim that
the API obeys. See `lambda/internal-directory/handler.ts`.

One thing the token will not tell your API is that an agent was involved. Okta
emits neither `act` nor `may_act`, but `cid` changes from the sign-in client to
the exchange client while `sub` stays the user, so a resource server can tell an
agent-mediated call from a direct one.

---

## Verifying it

This needs the rest of the README first: deploy, then wire up Slack. Once the bot
answers, @-mention it and ask it who you are.

The check that matters is then moving your own account from `employees` to
`contractors` and asking again. The same question should come back refused with no
redeploy, because the group is read from the claim when the token is minted. One
catch: AgentCore has already cached the exchanged token, and there is no API to
delete it, so mention the bot with the words **force re-auth** to start a fresh
sign-in, or wait for the token to expire.

When sign-in fails, **Reports > System Log** is the place to look. Useful event
names: `app.oauth2.as.authorize.code`,
`app.oauth2.as.token.grant.access_token`, and `policy.evaluate_sign_on`. It lags
by up to a minute, so wait before concluding nothing happened.

---

## Gotchas

Things that cost time, in the order we hit them.

- **Register the sign-in provider with the `OktaOauth2` vendor, not
  `CustomOauth2`.** This one cost a day. With `CustomOauth2` and a discovery URL
  the sign-in flow fails **silently**: Okta authenticates the user and issues the
  token, and AgentCore leaves the authorization session at `IN_PROGRESS` forever,
  with no error in CloudTrail, the Lambda logs, or Okta's System Log. The same
  client registered as `OktaOauth2` with explicit endpoints works first try. The
  on-behalf-of provider is unaffected and stays `CustomOauth2`, because it needs
  the token-exchange block.
- **Repoint AWS before deleting anything in Okta.** Deleting an authorization
  server a deployed runtime still references leaves the runtime unreadable,
  because its own validation fetches the dead discovery URL. Even CloudFormation
  cannot update it. Recovering means an out-of-band `update-agent-runtime`, then
  `continue-update-rollback --resources-to-skip`.
- **The token-exchange grant is invisible in discovery.** It is absent from
  `grant_types_supported` and works anyway.
- **Okta's system scopes are stripped in some exchange flows**, so do not rely on
  `openid` or `profile` surviving one.
- **There is no delete-token API.** Only `Get*`. The only way to clear a
  mis-bound cached token is `forceAuthentication=true` on the next call.
