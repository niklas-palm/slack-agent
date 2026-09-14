// Read a SecureString secret from SSM, with a process-env override for local
// dev. Resolution order:
//   1. process.env[envVar]                          - local dev short-circuit
//   2. ${AGENT_SHARED_SECRETS_SSM_PREFIX}/<suffix>   - the deployed runtime
//
// Local dev never hits AWS - `export SLACK_BOT_TOKEN=...` is enough.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

export async function loadSlackBotToken(): Promise<string> {
  const envVar = 'SLACK_BOT_TOKEN';
  const ssmSuffix = 'slack-bot-token';
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;

  const prefix = process.env.AGENT_SHARED_SECRETS_SSM_PREFIX;
  if (!prefix) {
    throw new Error(
      `${envVar} not set in env and no SSM prefix configured - running outside the runtime?`,
    );
  }

  const name = `${prefix}/${ssmSuffix}`;
  const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const v = r.Parameter?.Value;
  if (!v) throw new Error(`${envVar}: empty or missing SSM parameter ${name}`);
  return v;
}
