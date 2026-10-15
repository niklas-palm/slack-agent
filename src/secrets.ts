// Load the Slack bot token: SLACK_BOT_TOKEN from the environment for local dev,
// otherwise the SSM SecureString named by SLACK_BOT_TOKEN_PARAM.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

export async function loadSlackBotToken(): Promise<string> {
  const fromEnv = process.env.SLACK_BOT_TOKEN;
  if (fromEnv) return fromEnv;

  const name = process.env.SLACK_BOT_TOKEN_PARAM;
  if (!name) {
    throw new Error('neither SLACK_BOT_TOKEN nor SLACK_BOT_TOKEN_PARAM is set');
  }

  const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const v = r.Parameter?.Value;
  if (!v) throw new Error(`empty or missing SSM parameter ${name}`);
  return v;
}
