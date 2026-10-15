// Load the Slack bot token: SLACK_BOT_TOKEN from the environment for local dev,
// otherwise the SSM SecureString under AGENT_SHARED_SECRETS_SSM_PREFIX.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

export async function loadSlackBotToken(): Promise<string> {
  const fromEnv = process.env.SLACK_BOT_TOKEN;
  if (fromEnv) return fromEnv;

  const prefix = process.env.AGENT_SHARED_SECRETS_SSM_PREFIX;
  if (!prefix) {
    throw new Error(
      'SLACK_BOT_TOKEN not set in env and no SSM prefix configured - running outside the runtime?',
    );
  }

  const name = `${prefix}/slack-bot-token`;
  const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const v = r.Parameter?.Value;
  if (!v) throw new Error(`empty or missing SSM parameter ${name}`);
  return v;
}
