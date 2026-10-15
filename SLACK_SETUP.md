# Slack app setup

You'll create a Slack app, point it at the deployed webhook, and store its
two credentials in SSM. Do this once.

> Deploy first. You'll need the events URL printed as the
> `SlackAgent-Trigger.SlackEventsUrl` output in step 4.

## 1. Create the Slack app

Go to <https://api.slack.com/apps> -> **Create New App** -> **From manifest**.
Pick your workspace, then paste this manifest as-is:

```yaml
display_information:
  name: AgentCore Bot
  description: Bedrock AgentCore-powered assistant
features:
  bot_user:
    display_name: AgentCore Bot
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read       # receive @-mentions
      - chat:write              # post replies + sign-in links
      - reactions:write         # eyes reaction to ack a returning user
      - channels:history        # read public-channel threads
      - groups:history          # read private-channel threads
      - users:read              # resolve the mentioning user
      - users:read.email        # ...to their email (broker vault key + subject-match)
      - files:read              # download thread attachments
      - files:write             # upload generated files
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

The bot is meant to be @-mentioned in a channel, so it asks for
channel-history scopes and no DM scopes at all.

Event subscriptions are deliberately left out here. The moment you give Slack
the request URL it calls it with a `url_verification` challenge, and the
trigger Lambda verifies Slack's signature before it answers anything, so it
needs the signing secret in SSM first. You'll wire the URL up in step 4.

> **`users:read.email` is required.** The trigger Lambda resolves the
> mentioning user to their email and uses it as the broker vault key (to
> look up their Okta token) and for the subject-match check. With the scope
> missing, every @-mention aborts at email resolution.

## 2. Install and grab credentials

1. **Install to Workspace** and authorize.
2. Copy the **Bot User OAuth Token** (*OAuth & Permissions*, starts `xoxb-`).
3. Copy the **Signing Secret** (*Basic Information -> App Credentials*).

## 3. Store the credentials in SSM

The trigger Lambda reads both as SecureString parameters; the runtime reads only
the bot token. Create them once, from the repo root:

```bash
REGION=$(make -s region)   # same precedence as the deploy: config.local.json over config.json

aws ssm put-parameter --region "$REGION" \
  --name '/SlackAgent-Runtime/secrets/shared/slack-bot-token' \
  --type SecureString --value 'xoxb-...YOUR-TOKEN...'

aws ssm put-parameter --region "$REGION" \
  --name '/SlackAgent-Runtime/secrets/shared/slack-signing-secret' \
  --type SecureString --value '...YOUR-SIGNING-SECRET...'
```

Re-running with `--overwrite` rotates them. Both the runtime and the trigger
Lambda cache these for the life of the process, so a rotation takes effect on
the next cold start. Until a warm Lambda recycles it keeps using the old signing
secret, and every mention fails signature verification.

## 4. Subscribe to events

Now that the signing secret is in SSM, the Lambda can answer Slack's
challenge. In the app under **Event Subscriptions**:

1. Toggle **Enable Events** on.
2. Paste the events URL from the deploy output into **Request URL**, e.g.
   `https://<id>.execute-api.<region>.amazonaws.com/prod/slack/events`.
   Slack calls it immediately and should show **Verified**.
3. Under **Subscribe to bot events**, add `app_mention`, then **Save Changes**.
4. Slack will prompt you to reinstall the app. Do it.

If verification fails, the signing secret is missing or wrong. Check with
`aws ssm get-parameter --region "$REGION" --name '/SlackAgent-Runtime/secrets/shared/slack-signing-secret' --with-decryption`.

## 5. Try it

Back to [README step 5](./README.md#5---try-it): invite the bot to a channel,
mention it, and sign in when it posts the link.
