# slack-agent

**A Slack-connected code agent on AWS Bedrock AgentCore Runtime that acts on a
user's behalf against internal APIs.** @-mention the bot in a thread and it
replies in-thread, with a sandboxed code/file/web toolset and the ability to
call an internal, Okta-protected API **as the user** via On-Behalf-Of (OBO)
token exchange (RFC 8693).

The identity model is the point of this sample: the user's identity is
**proven** (the runtime is invoked with the user's Okta JWT, validated by an
inbound JWT authorizer), and the agent **exchanges that token** for one scoped
to a downstream internal API. No token ever reaches the model, the sandbox's
files or its environment, and the agent never acts as itself - every internal
call carries the user's delegated identity.

> Third-party 3LO (e.g. "read my Spotify") is a different pattern - a separate
> trust domain, interactive consent per provider. This sample deliberately
> focuses on the **internal-API / OBO** case to keep one idea clear.

Built on the [Strands Agents SDK](https://github.com/strands-agents)
(TypeScript) - the same minimal code-agent harness as the
[minimal-harness](https://github.com/niklas-palm/minimal-harness) sample, with a
Slack trigger and the Okta-JWT + OBO identity machinery added. Read that first
for the bare agent; read this for how an agent proves and delegates a user's
identity.

```
@AgentCore Bot what's my internal directory profile?
                              │
   ┌──────────────────────────┴───────────────────────────────┐
   │ proves your identity (Okta JWT) · exchanges it for a       │
   │ directory-scoped token (OBO) · calls the internal API      │
   │ AS YOU · replies in-thread                                 │
   └────────────────────────────────────────────────────────────┘
```

---

## Deploy

Before you start: pick your region (`region` in `config.json`, default
`eu-west-1`) and run `make install`. Decide the region now, because the
credential providers you create in step 1 are regional.

1. Set up Okta and the two AgentCore credential providers (**[OKTA_SETUP.md](./OKTA_SETUP.md)**).
   It ends with your Okta values in `config.json` or `config.local.json`.
2. `make bootstrap` and `make observability.enable` (once per account+region).
3. Start Docker, then `make deploy`.
4. Create the Slack app and store its two secrets in SSM (**[SLACK_SETUP.md](./SLACK_SETUP.md)**).
5. @-mention the bot and sign in to Okta when it asks.

### Prerequisites

**Accounts & access**

- An **AWS account** with active credentials (`aws sts get-caller-identity`),
  and permissions to create IAM roles. `make observability.enable` also changes
  account-wide X-Ray settings, so admin-equivalent access is the easy path.
- **Amazon Bedrock model access** for the model in `config.json`, enabled under
  *Bedrock > Model access*. Mind which region: an `anthropic.*` id needs access
  in `config.json`'s region, while the default `openai.*` id runs through
  Bedrock's OpenAI-compatible endpoint and needs it in **us-east-1** (see
  [Configuration](#configuration)). If the model is not enabled, every
  @-mention fails and Slack only shows ":warning: Sorry - something went wrong",
  with the real error in the runtime log group.
- A **Slack workspace** where you can create and install an app.
- An **Okta Integrator org** (free; a Workforce Identity org lacks the token exchange grant) with the apps, authorization
  server, and AgentCore credential providers from **[OKTA_SETUP.md](./OKTA_SETUP.md)**.
  This is the bulk of the one-time identity setup; do it first.

**Tools on your machine**

| Tool | Version | Why |
|---|---|---|
| **Node.js + npm** | 20+ (22 recommended) | CDK app, Lambda bundling, the TS runtime |
| **AWS CLI v2** | recent enough for the check below | ECR login, STS, SSM, AgentCore Identity |
| **Docker** with **Buildx** | recent | builds the ARM64 runtime image (Docker Desktop has the arm64 emulation; on plain Linux register it with `docker run --privileged --rm tonistiigi/binfmt --install arm64`) |
| **AWS CDK** | v2 (installed by `make install`) | `make bootstrap` once per account+region |
| **make**, **bash**, `curl`, `uuidgen`, `shasum` | - | the `Makefile` orchestration |

Check your CLI knows the token-exchange provider config, which older versions do not:

```bash
aws bedrock-agentcore-control create-oauth2-credential-provider help | grep -q onBehalfOfTokenExchangeConfig && echo "CLI ok"
```

> **The runtime image is ARM64** (AgentCore requires it); the Makefile builds
> with `docker buildx --platform linux/arm64`. Region, model and feature
> switches live in **`config.json`**, read by the Makefile, the CDK app and the
> container alike. The shell's `AWS_REGION` is ignored on purpose.

### 1 - Okta + AgentCore providers

Work through **[OKTA_SETUP.md](./OKTA_SETUP.md)**: two org groups, one
authorization server, two Okta apps (sign-in + token-exchange), and the
`okta-signin` / `okta-exchange` AgentCore credential providers. It is all done in
the Okta console, with no admin API token, apart from one AWS command for the
credential providers. It opens with the four roles any identity provider has to
fill, so the same design carries to Entra, Auth0 or Cognito, and it covers what
Okta enforces and what it does not along with the non-obvious gotchas (redirect
URI, app username format, DPoP).

### 2 - Bootstrap

```bash
make check                # typecheck + lint
make bootstrap            # one-time per account+region: cdk bootstrap
make observability.enable # one-time per account+region: tracing destination
```

### 3 - Deploy the infrastructure

Start Docker Desktop first; the image is built locally.

```bash
make deploy
```

Builds + pushes the container (content-hash tagged, skipped if unchanged), then
`cdk deploy --all`. These outputs matter:

- **`SlackAgent-Trigger.SlackEventsUrl`** - the Slack webhook URL. You paste it
  into Slack's Event Subscriptions in step 4, after the secrets are in SSM. To
  get it again later:
  `aws cloudformation describe-stacks --region "$(make -s region)" --stack-name SlackAgent-Trigger --query "Stacks[0].Outputs[?OutputKey=='SlackEventsUrl'].OutputValue" --output text`
- **`SlackAgent-Trigger.CallbackUrl`** - nothing to do with this one. It is where AgentCore returns the
  user after sign-in. This is the `resourceOauth2ReturnUrl`, registered on the
  broker workload identity by the stack. It must **not** be in Okta's redirect
  allow-list; that list holds AgentCore's own callback (see OKTA_SETUP.md).
- **`SlackAgent-InternalApis.DirectoryApiUrl`** and **`TicketsApiUrl`** - the
  two OBO targets. The stack hands their base URLs to the runtime, and the
  in-VM proxy forwards there.

Sanity check before moving on: the directory API should refuse an unsigned
call, which proves the JWT authorizer is live.

```bash
curl -s -o /dev/null -w '%{http_code}\n' <DirectoryApiUrl>   # expect 401
```

To change the model or a feature switch, edit `config.json` and deploy again.
Changing `region` also means setting `webSearch: false` unless the managed
web-search connector exists in the new region.

### 4 - Create the Slack app and store its credentials

Follow **[SLACK_SETUP.md](./SLACK_SETUP.md)**, which has the app manifest, the
two SSM commands, and the order they have to happen in: the signing secret must
be in SSM before you give Slack the request URL, because the trigger Lambda
verifies Slack's signature before it answers the verification challenge.

The two secrets are provisioned out of band, never in CDK, so they stay out of
CloudFormation.

### 5 - Try it

```text
/invite @AgentCore Bot
@AgentCore Bot what's my internal directory profile?
```

First time, the bot posts a sign-in link in the thread; sign in to Okta and it
continues automatically and replies with your directory profile.

The bot matches you by email, so sign in to Okta as the user whose email is the
same as your Slack profile email. If they differ, it replies ":no_entry: The
connected account doesn't match your Slack identity".

Watch it:

```bash
R=$(make -s region)
aws logs tail --region $R "$(aws logs describe-log-groups --region $R --log-group-name-prefix /aws/lambda/SlackAgent-Trigger-SlackEventsFn --query 'logGroups[0].logGroupName' --output text)" --since 5m --follow
aws logs tail --region $R "$(aws logs describe-log-groups --region $R --log-group-name-prefix /aws/bedrock-agentcore/runtimes/slack_agent- --query 'logGroups[0].logGroupName' --output text)" --since 5m --follow
```

To re-authenticate (switch accounts / clear a cached token), include
**`force re-auth`** in your mention.

### Redeploy and tear down

```bash
make deploy     # rebuilds the image only if code changed
make destroy    # asks once, then removes all three stacks
```

Idle cost is close to nothing: the per-mention cost is the model call, plus
whatever CloudWatch and X-Ray ingest the tracing produces. `make destroy`
deliberately leaves a few things behind, so clean these up by hand when you are
done:

- the two SSM secrets, and the ECR repo **with its images** (storage cost);
- the `slack_broker` workload identity (RETAINed, because deleting it would
  orphan every user's vaulted token) and the two credential providers
  `okta-signin` and `okta-exchange`;
- the runtime and Lambda log groups;
- the account-wide Transaction Search setting from `make observability.enable`,
  which is the one that keeps charging. Turn the sampling back down with
  `aws xray update-indexing-rule --region <region> --name Default --rule
  '{"Probabilistic":{"DesiredSamplingPercentage":5}}'`;
- the Okta-side apps, authorization server, groups and scopes.

---

## How it works

**A code agent behind Slack.** The agent is a loop plus the same handful of
general tools as `minimal-harness` (`read_file`, `write_file`, `edit_file`,
`bash`, `web_fetch`). This sample adds four Slack
tools and the identity machinery. `bash` is what makes it a code agent: it
writes and runs its own scripts (python3, curl) to get things done.

**Identity is proven, not asserted.** The runtime has an **inbound Okta JWT
authorizer**: every invocation must carry a Bearer token issued by our Okta
authorization server, for the right audience. The Slack trigger Lambda obtains
that token for the @-mentioning user (brokered through AgentCore Identity) and
invokes the runtime with it. So by the time the agent runs, AgentCore holds the
user's proven identity on the workload context.

**Acting on the user's behalf (OBO).** The agent never handles a token. It
calls internal APIs through a tiny **loopback proxy** the harness runs inside
the microVM: its own code (python3 or curl via `bash`) hits
`http://127.0.0.1:8899/<api>/<path>` with no credentials. The proxy looks the
API up in a catalog, exchanges the inbound user token for one scoped to that
API (audience + scope per API, via AgentCore Identity), calls the real API, and
returns the response. The exchanged token carries the **user's** identity, so
the internal API sees who it acts for - not the agent. Non-interactive: no
consent screen, no waiting. The token lives only in the harness process, never
in the model's context and never in the sandbox.

**One isolated microVM per @-mention.** The trigger Lambda uses a fresh
`runtimeSessionId` per mention, so every invocation gets its own microVM
(isolated compute, RAM, filesystem). No two users share an environment -
which is what makes it safe to hand the agent a raw shell and to bind the
proxy to loopback with one user's identity. The microVM is ephemeral:
nothing persists between mentions.

**Fail closed, no fallbacks.** Missing config throws at startup; an unresolved
user email aborts the request; and a token whose subject doesn't match the
@-mentioning user is **refused** rather than used (see "identity binding").

---

## Architecture

Three CDK stacks, all in the region set in `config.json` (`eu-west-1`):

| Stack | Owns |
|---|---|
| `SlackAgent-Runtime` | The `CfnRuntime` (container) + its IAM role + the inbound Okta JWT authorizer, and the web-search gateway |
| `SlackAgent-InternalApis` | The two OBO targets: the directory API (gates on the caller's group) and the ticket API (read/write, per record) |
| `SlackAgent-Trigger` | One API Gateway with the Slack webhook and the sign-in callback, a Lambda behind each, the broker workload identity, and the parked-request table |

Request flow for one `@-mention` (returning user, already signed in):

```
Slack ──HTTPS──► SlackAgent-Trigger Lambda
                   │  verify signature · resolve user -> email (Slack API)
                   │  broker the user's Okta token (GetWorkloadAccessTokenForUserId
                   │    -> GetResourceOauth2Token) · verify token.sub == email
                   ▼
              POST the runtime endpoint with  Authorization: Bearer <okta-jwt>
                   │  payload = { prompt, slack:{...} }
                   ▼
              AgentCore Runtime  (one microVM; inbound JWT authorizer validates the token)
                   │  agent's code: curl http://127.0.0.1:8899/directory/me  (no token)
                   │  in-VM proxy: OBO exchange -> calls the internal directory API AS the user
                   ▼
              reply posted back into the Slack thread
```

First-time user (no vaulted token): the Lambda parks the request and posts a
**sign-in link** in the thread, then stops. When the user signs in, the
**callback** they land on completes the token and invokes the runtime with the
parked request. Nothing polls, nothing waits, and no re-mention is needed. The
link is good for ten minutes, which is how long AgentCore keeps the
authorization session; after that the bot asks you to mention it again.

---

## The internal-API proxy (loopback)

The one piece that isn't in `harness`. `src/internalApiProxy.ts` runs a small
HTTP listener on `127.0.0.1:8899` inside the microVM. When the agent wants an
internal API, its own code calls it, path-routed by API name, with no
credential:

```bash
curl -s http://127.0.0.1:8899/directory/me
```

For each request the proxy:

1. looks the API up in `src/catalog.ts` (base URL, credential provider,
   audience, scopes);
2. does the On-Behalf-Of exchange with AgentCore Identity (`withAccessToken`
   from the TS SDK), using the workload access token the runtime SDK exposed on
   the invocation - the user's proven identity;
3. calls the real API with the minted token and returns the response.

The API's own JWT authorizer then validates that token and sees the **user's**
`sub`, not the agent's. It decides whether this user may have the data from the
token's `groups` claim.

`GET http://127.0.0.1:8899/` lists the APIs with descriptions, so discovery is
one call. The system prompt tells the agent the mechanism; it never sees a
token, a scope or an audience.

**Why a proxy and not a tool or an SDK in the sandbox.** A hand-written tool per
API is coupling, and a code agent with a shell can route around it anyway. An
identity SDK inside the sandbox puts the token in a process the agent wrote,
and needs the workload identity bridged across the process boundary. The proxy
keeps the agent writing plain Python/curl, keeps the token in the harness
process where the identity already is, and gives the shell nothing to route
around: the loopback proxy is the only path to the credential.

Be precise about how strong that is. The boundary is process-level, not a
sandbox: the agent's shell shares the microVM and the task role. What the proxy
buys is that no token is ever in the model's context, on disk, or in the
environment, and that the runtime's role is scoped so that nothing minted from
inside the sandbox could exceed what the proxy would have handed back anyway.
If you need more than that, the next step is a separate code sandbox the proxy
sits outside of.

**Scopes are owned by the catalog, and capped by Okta.** The agent names an API
and a path; the proxy decides what to request, so the model can't escalate.
Okta caps what the agent's client may ever be minted, but ignores the user's
group membership on an exchange, so the resource server enforces that from the
`groups` claim. The evidence is in
[What Okta enforces](./OKTA_SETUP.md#what-okta-enforces-and-what-it-does-not).

---

## The two internal APIs, and two kinds of authorization

There are two OBO targets on purpose, because they answer different questions and
only one of them could have been pushed into the identity provider.

| | `directory` | `tickets` |
|---|---|---|
| Question | is this person an employee | which records are yours |
| Answered from | the `groups` claim Okta signed | the token's `sub`, as the DynamoDB partition key |
| Could Okta enforce it? | yes, if it evaluated group conditions on exchange, which it does not | no, a scope or group cannot express per-record access |
| Scopes | `directory.read`, plus `directory.write` the agent can never obtain | `tickets.read` to list, `tickets.write` to create or modify |

`directory.write` is how the sample shows the ceiling, and it holds in two
layers. The catalog only ever asks for `directory.read`, so the agent's token
never carries the write scope and the API's authorizer refuses `PATCH /me`. And
even if the catalog asked, no Okta rule grants `directory.write` on the exchange
grant, so Okta would refuse to mint it. To watch the first layer, ask the bot to
`PATCH http://127.0.0.1:8899/directory/me` with something like
`{"office": "Berlin"}`: it gets a plain 403 from API Gateway.

### Adding an internal API

A scope and an exchange rule in Okta
([how](./OKTA_SETUP.md#step-6---the-access-policy)), then a stack with
`authorizationScopes` on each route, wired in `cdk/bin/slack-agent.ts`, and one
entry in `src/catalog.ts`. No new authorization server, no new client, no change
to the agent's identity.

## The sign-in flow (first-time / re-auth)

The OBO exchange needs the user's identity to already be proven. Establishing
it the first time is interactive, and the Slack trigger must answer Slack within
3 seconds, so it can't block on a human:

1. The trigger Lambda brokers the user's Okta token via the **standalone
   `slack_broker` workload identity** (the runtime's own workload identity is
   service-linked and unusable by an outside caller). If a valid token is
   vaulted, it invokes the runtime immediately (and reacts with eyes).
2. If not, `GetResourceOauth2Token` returns a sign-in URL + a `sessionUri`. The
   Lambda parks the whole request under that `sessionUri` (prompt, channel,
   thread, user) with a short TTL, posts the link in the thread (**unfurl
   disabled** - the URL is single-use and Slack's link preview would consume
   it), and returns. Nothing is left running.
3. The user clicks, signs in to Okta, and AgentCore redirects them to our
   **callback**. That request is the signal that the human finished, so there
   is nothing to poll. The only deadline is AgentCore's ten-minute authorization
   session, which the parked request's TTL mirrors.
4. The callback reads the parked request, calls `CompleteResourceTokenAuth` to
   vault the token, reads that token straight back out of the vault, checks it
   belongs to this user, posts a checkmark, and invokes the runtime. No
   re-mention.

### Identity binding (fail closed)

`CompleteResourceTokenAuth` binds the token to whatever `userId` we assert and
does **not** verify the IdP-authenticated subject - so a stale browser SSO
session could vault a token for a *different* Okta user. Before invoking the
agent (in both the trigger Lambda and the callback), we decode the token and
require **`sub == the Slack-resolved email`**. On mismatch we refuse, post an
error, and do not invoke. No fallback. (This requires the token's `sub` to be
your Slack email: the same address in Okta and Slack, and an app username format
that yields it - see OKTA_SETUP.md steps 1 and 3.)

---

## Shortcuts taken for the sample

- **The sign-in link goes into the Slack thread.** Anyone in the channel can
  click it and sign in as themselves. It fails closed, because both Lambdas
  refuse to act unless the token's `sub` equals the Slack-resolved email, but the
  user is left with a mis-bound vault entry and a burned single-use link. Send it
  to one person out of band: a DM, a push notification, an email.
- **The API catalog is a static array** baked into the image. In production,
  fetch it from a central registry on boot.
- **No per-user filtering of the catalog.** The agent may try an API this user
  cannot reach and gets a clean 403, which the prompt tells it means the user is
  unauthorized rather than something being broken.
- **The agent's shell shares the runtime's role.** So code the agent writes can
  do what that role can. Two things matter:
  - It can read the **Slack bot token**, so it could read any channel the bot has
    been invited to, not just the one it was mentioned in. The Slack tools
    themselves are pinned to the thread.
  - It can read the **exchange client's secret**. AgentCore Identity reads that
    secret with the caller's credentials, so the runtime role has to be allowed
    to. On its own the secret mints nothing, since no rule grants it a scope
    without a user token, but it is a long-lived credential the agent could copy.

  In anything real, run the agent's code in a separate sandbox that does not hold
  the runtime's role.

## The toolset

The agent has the same base tools as `harness` (`src/tools.ts` and
`src/web.ts` are the same as in it):

| Tool | What it does |
|---|---|
| `read_file` | Read a text file with line numbers, paging with offset/limit |
| `write_file` | Create a file (refuses to overwrite one the agent hasn't read) |
| `edit_file` | Replace an exact, unique string in a file the agent has read |
| `bash` | Run a shell command: ls, rg, python3, git, curl, pip, anything |
| `web_fetch` | Fetch a page and return its text, HTML stripped |

`web_search` uses the AWS-managed web search connector behind an AgentCore
Gateway, provisioned by the Runtime stack when `webSearch` is true in
`config.json`. The gateway authenticates callers with IAM, so the runtime role
just needs `InvokeGateway` and there is no API key anywhere. The connector is
region-limited, which is why this sample runs in `eu-west-1`.

Plus four **Slack tools** bound to the thread: `get_slack_thread`,
`download_slack_file`, `respond_to_thread`, `upload_to_thread`. Tools return
`{error, hint}` rather than throwing, so the agent adapts. They are deliberately
dumb: closure-bound to the channel and thread of the mention, so the model
cannot retarget them, and they carry no user id because the token already does.

**Internal APIs are not tools.** The agent reaches them by writing code against
the in-VM proxy (see "The internal-API proxy" above). How to call it is in the
system prompt; which APIs exist comes from `GET http://127.0.0.1:8899/`.

**Skills.** The agent can load *skills* - folders under `skills/` each with a
`SKILL.md` that Strands lists in the system prompt and the agent pulls in on
demand. There's one small worked example in `skills/ascii-banner/`.

---

## Configuration

`config.json` at the repo root is the single source of truth:

```json
{
  "region": "eu-west-1",
  "bedrockModelId": "openai.gpt-5.6-luna",
  "webSearch": true,
  "tracing": true,
  "okta": {
    "domain": "<your-okta-domain>.okta.com",
    "authorizationServerId": "<your-authorization-server-id>"
  }
}
```

| Key | What it does |
|---|---|
| `region` | Where the stacks deploy. Read by the Makefile, the CDK app and the container, so there is nothing else to keep in step. An `openai.*` model is the one exception: it is reached in us-east-1 regardless. |
| `bedrockModelId` | The model the agent runs on. Anthropic or OpenAI; swap the string and `make deploy`. Note that an `openai.*` id is served from us-east-1, so prompts and internal-API responses leave `region`. |
| `webSearch` | Provisions the managed web-search connector behind an AgentCore Gateway and wires the `web_search` tool. |
| `tracing` | Sends OpenTelemetry spans to CloudWatch GenAI Observability. |
| `okta.*` | Your Okta org: a bare hostname with no `https://`, and the id of the custom authorization server from OKTA_SETUP.md. |

Changing the model really is just that one string, and `src/agent.ts` picks the
provider from it. Anthropic ids go through Bedrock's Converse API, while OpenAI
ids like the default go through Bedrock's OpenAI-compatible endpoint, which
currently only exists in `us-east-1` and is pinned there independently of
`region`. Both are keyless, minting a token from the same AWS credentials, so
there is no API key either way. Use the plain `openai.*` id: the `global.`
cross-region profiles are Anthropic-only, and a `global.` prefix on an OpenAI id
is stripped rather than honoured.

For which models exist in which regions, see the
[Bedrock supported models](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html)
docs. An `anthropic.*` id goes through the Converse API, so you can check it
answers before deploying:

```bash
aws bedrock-runtime converse --region "$(make -s region)" \
  --model-id global.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --messages '[{"role":"user","content":[{"text":"hi"}]}]' >/dev/null && echo "model ok"
```

There is no equivalent one-liner for an `openai.*` id, since it does not use the
Converse API. Enable it in us-east-1 and the first @-mention will tell you.

The tracked file ships placeholders for the Okta values and the deploy refuses
to run until you replace them. If you would rather not edit a tracked file, put
your values in `config.local.json`, which is untracked and merged over
`config.json`, so it only needs the keys you change.

No deploy flags. Slack secrets stay in SSM. Only four values reach the container
as env vars: the bot token's SSM parameter name, the two internal API base URLs,
and the observability switch. A fifth, the web-search gateway URL, is added when
`webSearch` is on.

---

## Tracing

Same as `harness`: the container loads AWS's OpenTelemetry distro at startup
(the `--import .../register` in the Dockerfile), which exports Strands' spans
and token-usage metrics to X-Ray and CloudWatch, tags the resource as an agent,
and fills the Agent, Session and Trace views in
**CloudWatch > GenAI Observability**. `server.ts` puts `session.id` in
OpenTelemetry baggage so the distro stamps it on every span, and `buildAgent`
also tags the root span with `slack.user_id`, `slack.channel_id` and
`slack.thread_ts` via Strands' `traceAttributes`, so you can find a session by
who ran it or which thread it was in. The distro runs only when the stack sets
`AGENT_OBSERVABILITY_ENABLED` (when `tracing` is true); otherwise it sets
`OTEL_SDK_DISABLED` and the same image ships nothing.

```bash
make observability.enable   # once per account/region: Transaction Search, 100% indexing
```

In agent mode the distro records prompts, model output and tool payloads as
span events, visible in the trace detail. This sample leaves that on; if you
don't want conversation content in your logs, add a Strands option to stop
recording it or sign the export yourself with a redacting step.

---

## Local development (no Slack, no deploy)

```bash
cp .env.local.example .env.local
make up                                  # builds + runs the container + mock Slack
make invoke PROMPT='hi'
make logs ; make down
```

`make invoke` posts a synthetic payload straight to the runtime; the mock
server (`test/mock-slack/`) serves a canned thread. The internal-API proxy needs
a real inbound user token, so locally it answers `401 no proven user identity`;
exercise the on-behalf-of path through a deployed Slack mention.

The model call is real, so the container needs AWS credentials, and Compose
forwards them only as environment variables. On SSO or a named profile, export
them first:

```bash
eval "$(aws configure export-credentials --format env)"
```

```bash
make check    # typecheck + lint - the gate before committing
```

---

## File map

```
config.json           region, model, feature switches, Okta domain + AS id (Makefile, CDK and runtime read it)
src/                  runtime container (TypeScript)
  server.ts           AgentCore entrypoint; hands the user's identity to the proxy
  agent.ts            buildAgent() - composes prompt + tools + trace attributes; runs the stream
  internalApiProxy.ts the loopback proxy: catalog lookup -> OBO exchange -> forward
  catalog.ts          the internal APIs the agent may call (name, base URL, provider, audience, scopes)
  tools.ts            the four base tools (same as harness)
  web.ts              web_fetch + web_search (same as harness)
  config.ts           reads config.json; the one place runtime config comes from
  slackTools.ts       the four Slack tools, closure-bound to channel/thread
  prompt.ts           system prompt   ·   secrets.ts  SSM loader
  emit.ts             JSON-line logger
skills/ascii-banner/  sample skill (same as harness)
lambda/
  slack/shared.ts     broker the user's token, verify its subject, post to the thread, invoke
  slack/events.ts     the Slack webhook: mention -> token -> runtime, or park + sign-in link
  slack/callback.ts   the sign-in callback: complete the token, resume the parked request
  internal-directory/ an OBO target - mock internal API, gated on the caller's group
  internal-tickets/   a second OBO target - read/write, gated per record
cdk/lib/              runtime / internal-apis / slack
test/mock-slack/      tiny local Slack Web API stand-in for `make up`
```

See **[OKTA_SETUP.md](./OKTA_SETUP.md)** for the identity setup, what Okta does
and does not enforce, and the gotchas that cost us time.

---

## If it doesn't work

Each failure has its own message in the thread, so start with what the bot said.

| What you see | What it means |
|---|---|
| Nothing at all, no reaction | The events URL or the signing secret is wrong. Check the trigger Lambda's log, then SLACK_SETUP.md step 4. |
| ":warning: I couldn't look up your email address, so I can't act as you" | The bot is missing the `users:read.email` scope (SLACK_SETUP.md step 1). |
| ":warning: I couldn't reach the identity provider" | The `okta-signin` credential provider is missing, misnamed, or in another region (OKTA_SETUP.md step 5). |
| ":no_entry: The connected account doesn't match your Slack identity" | Your Okta user's email differs from your Slack email (OKTA_SETUP.md step 1), or the app's username format isn't the email (step 3). |
| The sign-in link never completes, or you get a second one | The authorization session expired after ten minutes, or the credential provider is the wrong vendor (OKTA_SETUP.md gotchas). |
| ":warning: Sorry - something went wrong" | The agent itself failed. The real error is in the runtime log group; the usual cause is model access not enabled in the right region. |
| The agent replies but says it isn't authorized for an API | Expected for `directory.read` if you are not in `employees`, and for anything needing `directory.write`. That is the ceiling working. |

---

## License

[MIT](./LICENSE).
