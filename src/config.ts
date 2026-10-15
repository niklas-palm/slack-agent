// Runtime configuration. config.json at the repo root is the single source of
// truth for region, model and feature switches, read by the CDK stack and the
// running container alike (it's copied into the image). Values the stack only
// knows after deploy, like the internal API URLs, arrive as env vars instead.
//
// We deliberately do NOT read AWS_REGION: a stale shell value once misrouted
// calls to another region.
import { readFileSync } from 'node:fs';

// Only region and model are read here; webSearch, tracing and okta are read by
// the CDK app from the same file, and the Makefile reads region.
interface SlackAgentConfig {
  region: string;
  bedrockModelId: string;
}

// config.local.json is an untracked override, so the tracked file can keep
// placeholders for the values that are specific to your Okta org. It is merged
// OVER config.json, so it only needs the keys you actually want to change.
function readConfig(): SlackAgentConfig {
  const base = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  let local = {};
  try {
    local = JSON.parse(readFileSync(new URL('../config.local.json', import.meta.url), 'utf8'));
  } catch (e) {
    // Absent is normal. Present but unparseable is not, and silently ignoring it
    // would blame config.json for whatever went missing.
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
  return { ...base, ...local } as SlackAgentConfig;
}

const config = readConfig();

export const REGION = config.region;
export const BEDROCK_MODEL_ID = config.bedrockModelId;

// Set by the stack when webSearch is true in config.json: the URL of the
// AgentCore Gateway fronting the AWS-managed web search connector. Empty means
// the tool isn't registered (see agent.ts).
export const WEB_SEARCH_GATEWAY_URL = process.env.WEB_SEARCH_GATEWAY_URL ?? '';

// Base URLs of the internal APIs, set by the stack from each API's own stack.
// The in-VM proxy forwards the agent's calls here after the OBO exchange.
export const INTERNAL_DIRECTORY_URL = process.env.INTERNAL_DIRECTORY_URL ?? '';
export const INTERNAL_TICKETS_URL = process.env.INTERNAL_TICKETS_URL ?? '';

// Slack API base - overridable for local dev.
export const SLACK_API_BASE = process.env.SLACK_API_BASE ?? 'https://slack.com/api';
// The agent's sandbox. File tools refuse to touch anything outside it.
export const WORKSPACE_DIR = '/workspace';
// Where the AgentSkills plugin looks for skills. Baked into the image.
export const SKILLS_DIR = '/app/skills';
