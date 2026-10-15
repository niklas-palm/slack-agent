#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { App } from 'aws-cdk-lib';

import baseConfig from '../../config.json';

import { InternalApisStack } from '../lib/internal-apis-stack';
import { RuntimeStack } from '../lib/runtime-stack';
import { SlackStack } from '../lib/slack-stack';

// config.local.json is an untracked override for the values specific to your
// Okta org, so the tracked config.json can ship placeholders. It is merged OVER
// config.json (okta included), so it only needs the keys you want to change.
function readConfig(): typeof baseConfig {
  let local: Partial<typeof baseConfig> = {};
  try {
    local = JSON.parse(readFileSync(`${__dirname}/../../config.local.json`, 'utf8'));
  } catch (e) {
    // Absent is normal. Present but unparseable is not, and silently ignoring it
    // would blame config.json for whatever went missing.
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
  return { ...baseConfig, ...local, okta: { ...baseConfig.okta, ...local.okta } };
}
const config = readConfig();
if (config.okta.domain.startsWith('<') || config.okta.authorizationServerId.startsWith('<')) {
  throw new Error(
    'config.json still has placeholder Okta values. Set okta.domain and ' +
      'okta.authorizationServerId (see OKTA_SETUP.md), or put them in an ' +
      'untracked config.local.json.',
  );
}

const app = new App();

// The image tag comes from the Makefile, which content-hashes the sources.
const imageTag = app.node.tryGetContext('imageTag') as string | undefined;
if (!imageTag) throw new Error('pass -c imageTag=<tag>; `make deploy` does this');

// Region comes from config.json, the same file the container reads. We do NOT
// honour AWS_REGION or CDK_DEFAULT_REGION: a stale shell value once silently
// misrouted a deploy to a neighbouring region.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

// The Okta names below must match what OKTA_SETUP.md has you create and what
// src/catalog.ts requests. Your org and authorization server come from config.
const issuer = `https://${config.okta.domain}/oauth2/${config.okta.authorizationServerId}`;
const audience = 'api://internal';

const apis = new InternalApisStack(app, 'SlackAgent-InternalApis', {
  env,
  oidcIssuer: issuer,
  oidcAudience: audience,
  directoryGroup: 'employees',
});

// The Slack secrets are provisioned out of band (SLACK_SETUP.md); only their
// paths are needed. The trigger reads both, the runtime only the bot token.
const signingSecretParam = '/SlackAgent-Runtime/secrets/shared/slack-signing-secret';
const botTokenParam = '/SlackAgent-Runtime/secrets/shared/slack-bot-token';

const runtime = new RuntimeStack(app, 'SlackAgent-Runtime', {
  env,
  imageTag,
  tracing: config.tracing,
  webSearch: config.webSearch,
  oidcDiscoveryUrl: `${issuer}/.well-known/openid-configuration`,
  oidcAllowedAudience: audience,
  internalDirectoryUrl: apis.directoryUrl,
  internalTicketsUrl: apis.ticketsUrl,
  // Must match the `provider` on every entry in src/catalog.ts.
  exchangeProvider: 'okta-exchange',
  botTokenParam,
});

new SlackStack(app, 'SlackAgent-Trigger', {
  env,
  runtimeArn: runtime.runtimeArn,
  signingSecretParam,
  botTokenParam,
  brokerWorkloadName: 'slack_broker',
  userProvider: 'okta-signin',
  // offline_access makes Okta issue a refresh token, which AgentCore Identity
  // stores and uses, so one sign-in outlives the access token's sixty minutes.
  userScopes: ['openid', 'offline_access', 'agent.invoke'],
});

app.synth();
