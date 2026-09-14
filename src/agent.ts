// Strands Agent factory for the Slack agent.
//
// Each invocation builds a fresh Agent, since every Slack @-mention is an
// isolated runtime session. The system prompt is the static one plus this run's
// Slack context.
import { Agent, BedrockModel } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills';

import { BEDROCK_MODEL_ID, REGION, SKILLS_DIR, WEB_SEARCH_GATEWAY_URL } from './config.js';
import { emit, errMsg } from './emit.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { buildSlackTools, type SlackContext } from './slackTools.js';
import { TOOLS } from './tools.js';
import { webFetch, webSearch } from './web.js';

export interface SlackInvocation {
  channel_id: string;
  thread_ts: string;
  slack_user_id: string;
  trigger_message_ts: string;
}

export interface BuildArgs {
  slack: SlackInvocation;
  sessionId: string;
  slackCtx: SlackContext;
}

const MAX_TOKENS = 25000;

// Bedrock serves OpenAI models through an OpenAI-compatible endpoint ("Mantle")
// rather than the Converse API, so they need OpenAIModel instead of
// BedrockModel. Both are keyless: Mantle mints a bearer token from the same AWS
// credentials. Mantle currently only exists in us-east-1, so it is pinned there
// no matter where the rest of the stack runs.
const MANTLE_REGION = 'us-east-1';

function buildModel() {
  if (BEDROCK_MODEL_ID.includes('openai.')) {
    return new OpenAIModel({
      // `global.` cross-region profiles are an Anthropic thing; Mantle wants the plain id.
      modelId: BEDROCK_MODEL_ID.replace(/^global\./, ''),
      maxTokens: MAX_TOKENS,
      bedrockMantleConfig: { region: MANTLE_REGION },
      // The OpenAI client defaults to 10 minutes and 2 retries, so one wedged
      // request could hold the microVM for half an hour of billable time.
      clientConfig: { timeout: 120_000, maxRetries: 2 },
    });
  }
  return new BedrockModel({
    modelId: BEDROCK_MODEL_ID,
    region: REGION,
    maxTokens: MAX_TOKENS,
    cacheConfig: { strategy: 'auto' },
  });
}

export async function buildAgent(
  args: BuildArgs,
): Promise<{ agent: Agent; hasReplied: () => boolean }> {
  const { getSlackThread, downloadSlackFile, respondToThread, uploadToThread, hasReplied } =
    buildSlackTools(args.slackCtx);

  const systemPromptFull = `${SYSTEM_PROMPT}

## Slack context
- slack_user_id: ${args.slack.slack_user_id}  (Slack-only id, e.g. U06... - use only for Slack API calls like <@${args.slack.slack_user_id}>)
- channel: ${args.slack.channel_id}
- thread_ts: ${args.slack.thread_ts}
- trigger_message_ts: ${args.slack.trigger_message_ts}
- The human you're acting for is authenticated via their identity provider; the
  local internal-API proxy calls those APIs as them (no user id needed).
`;

  // Progressive-disclosure skills. The plugin injects a `<available_skills>`
  // metadata block into the system prompt and auto-registers a `skills`
  // tool the agent can call to load full instructions on demand. Skills
  // are baked into the container at /app/skills.
  const skillsPlugin = new AgentSkills({ skills: [SKILLS_DIR] });

  const agent = new Agent({
    name: 'slack-agent',
    model: buildModel(),

    tools: [
      ...TOOLS,
      webFetch,
      ...(WEB_SEARCH_GATEWAY_URL ? [webSearch] : []),
      getSlackThread,
      downloadSlackFile,
      respondToThread,
      uploadToThread,
    ] as any,
    plugins: [skillsPlugin],
    systemPrompt: systemPromptFull,
    printer: false,
    // Strands puts these on the root span only, which is enough to find a
    // session by Slack user or thread in the observability console. session.id
    // itself rides in on OpenTelemetry baggage (see server.ts) so it reaches
    // every span, which is what the console's Session view needs.
    traceAttributes: {
      'slack.user_id': args.slack.slack_user_id,
      'slack.channel_id': args.slack.channel_id,
      'slack.thread_ts': args.slack.thread_ts,
    },
  });

  emit('session_start', {
    session_id: args.sessionId,
    model_id: BEDROCK_MODEL_ID,
    slack_user_id: args.slack.slack_user_id,
    channel_id: args.slack.channel_id,
    thread_ts: args.slack.thread_ts,
  });

  return { agent, hasReplied };
}

// Runs the agent and mirrors the conversation to stdout as JSON lines. Whether
// the agent actually answered is tracked by the respond_to_thread tool itself
// (see slackTools.ts), not inferred from tool output here.
export async function runAgentStream(
  agent: Agent,
  prompt: string,
  sessionId: string,
): Promise<void> {
  const stream = agent.stream(prompt as any, { invocationState: { session_id: sessionId } });

  try {
    for await (const ev of stream) {
      const evAny = ev as any;
      if (evAny.type === 'modelMessageEvent') {
        for (const block of evAny.message?.content ?? []) {
          if (block?.type === 'textBlock' && block.text) {
            emit('text', { session_id: sessionId, content: String(block.text) });
          } else if (block?.type === 'toolUseBlock' && block.toolUseId && block.name) {
            emit('tool_input', {
              session_id: sessionId,
              name: block.name,
              tool_use_id: block.toolUseId,
              input: block.input ?? {},
            });
          }
        }
      } else if (evAny.type === 'toolResultEvent') {
        const tr = evAny.result;
        if (!tr) continue;
        const text = serializeToolResult(tr.content ?? []);
        emit('tool_result', {
          session_id: sessionId,
          tool_use_id: tr.toolUseId,
          result: text.slice(0, 4000),
        });
      }
    }
  } catch (e) {
    emit('stream_error', {
      session_id: sessionId,
      error: errMsg(e),
    });
  }
}

function serializeToolResult(content: any[]): string {
  return content
    .map((b: any) => (b?.text !== undefined ? String(b.text) : JSON.stringify(b)))
    .join('');
}
