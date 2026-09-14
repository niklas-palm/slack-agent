import { context, propagation } from '@opentelemetry/api';
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';

import { buildAgent, runAgentStream, type SlackInvocation } from './agent.js';
import { emit, errMsg } from './emit.js';
import { setWorkloadToken, startInternalApiProxy } from './internalApiProxy.js';
import { loadSlackBotToken } from './secrets.js';
import { postFallbackToThread } from './slackTools.js';

// One AgentCore microVM per runtimeSessionId. We deliberately use a fresh
// sessionId per Slack @-mention (the events Lambda generates a UUID), so
// every invocation is isolated - the agent reads thread context via
// get_slack_thread.
//
// One run per microVM, so nothing is shared between invocations.

// The loopback proxy the agent's own code calls to reach internal APIs on
// the user's behalf. Runs for the life of the container; one user per microVM.
startInternalApiProxy();

const app = new BedrockAgentCoreApp({
  config: {
    logging: { enabled: true, options: { level: 'warn' } },
    contentTypeParsers: [
      {
        contentType: 'application/octet-stream',
        parseAs: 'string',
        parser: (
          _req: unknown,
          body: unknown,
          done: (err: Error | null, value?: unknown) => void,
        ) => {
          try {
            done(null, body ? JSON.parse(body as string) : {});
          } catch (err) {
            done(err as Error);
          }
        },
      },
    ],
  },
  invocationHandler: {
    process: async (payload, invocation) => {
      const sid = invocation.sessionId;
      const body = (payload ?? {}) as Record<string, unknown>;
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      const slack = body.slack as SlackInvocation | undefined;

      if (!prompt) {
        return { status: 'rejected', error: "missing 'prompt' in payload" };
      }
      if (!slack || !slack.channel_id || !slack.thread_ts || !slack.slack_user_id) {
        return {
          status: 'rejected',
          error: "missing 'slack' metadata (need channel_id, thread_ts, slack_user_id)",
        };
      }

      // Hand the user's proven identity to the loopback proxy. The runtime SDK
      // exposes the workload access token (which carries the inbound user JWT)
      // on the invocation; the proxy uses it for the OBO exchange when the
      // agent calls an internal API. One user per microVM, so a single
      // captured token is safe.
      setWorkloadToken(invocation.workloadAccessToken);

      void wrappedRun({ prompt, slack, sessionId: sid }).catch((e) =>
        emit('error', { session_id: sid, error: errMsg(e) }),
      );
      // Nothing reads this response: the answer reaches the user through
      // respond_to_thread in Slack. Ack immediately and let the run continue.
      return { status: 'accepted', session_id: sid };
    },
  },
});

interface RunArgs {
  prompt: string;
  slack: SlackInvocation;
  sessionId: string;
}

const wrappedRun = app.asyncTask(run as (...args: unknown[]) => Promise<unknown>);

// Hard guarantee: the user must always see *something* in their thread.
// We load the bot token first so the fallback Slack post is always
// possible, even if buildAgent or the stream fails afterward.
async function run(args: RunArgs): Promise<void> {
  // Identity is PROVEN by the inbound Okta JWT: the runtime's authorizer
  // validated it, and the SDK exposes the resulting workload access token on
  // `context`. For OBO the agent needs nothing more - that token already
  // carries the user subject.
  const botToken = await loadSlackBotToken();
  let replied = false;
  const slackCtx = { botToken, channel: args.slack.channel_id, threadTs: args.slack.thread_ts };

  // Put session.id in OpenTelemetry baggage for the run. AWS's OpenTelemetry
  // distro (loaded in the Dockerfile CMD) copies baggage onto every span, so
  // the observability console groups this invocation's spans into one session.
  const traced = propagation.setBaggage(
    context.active(),
    propagation.createBaggage({ 'session.id': { value: args.sessionId } }),
  );

  try {
    const { agent, hasReplied } = await buildAgent({ ...args, slackCtx });
    await context.with(traced, () => runAgentStream(agent, args.prompt, args.sessionId));
    replied = hasReplied();
  } catch (e) {
    emit('error', { session_id: args.sessionId, error: errMsg(e) });
  } finally {
    // The microVM outlives this run by the idle timeout, and the agent is told
    // it may background work with nohup. Drop the user's token so nothing left
    // behind can still act as them.
    setWorkloadToken(undefined);
  }

  // If the agent never posted its own reply, post a fallback so the user
  // always sees something in their thread.
  if (!replied) {
    await postFallbackToThread(
      slackCtx,
      ":warning: Sorry - something went wrong and I couldn't finish your request. Please try again.",
    ).catch((e) =>
      emit('error', {
        session_id: args.sessionId,
        error: `fallback Slack post failed: ${errMsg(e)}`,
      }),
    );
  }

  emit('session_end', { session_id: args.sessionId, user_replied: replied });
}

app.run();
