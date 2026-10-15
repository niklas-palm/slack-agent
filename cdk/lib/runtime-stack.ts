// AgentCore CfnRuntime for the Slack agent.
//
// The runtime executes the agent. Inbound auth is an Okta JWT authorizer:
// every invocation must carry the user's Bearer JWT, so the user's identity
// is proven, and the agent exchanges that token (OBO) to call internal APIs.
// This stack owns the runtime + its IAM role (Bedrock, SSM, AgentCore
// Identity, and the token-vault Secrets Manager reads).
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { CfnGateway, CfnGatewayTarget, CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

const AGENTCORE_PRINCIPAL = 'bedrock-agentcore.amazonaws.com';
// Must match REPO_NAME in the Makefile, which builds and pushes the image.
const REPO_NAME = 'slack-agent';
const IDLE_TIMEOUT_SECONDS = 900;

export interface RuntimeStackProps extends StackProps {
  /** ECR image tag: the content hash the Makefile computes, passed as `-c imageTag=`. */
  readonly imageTag: string;
  /** AgentCore credential provider used for the OBO exchange. Must match the
   *  `provider` in src/catalog.ts; it scopes the vault and secret permissions. */
  readonly exchangeProvider: string;
  /** Let the runtime role export OpenTelemetry spans to X-Ray. */
  readonly tracing: boolean;
  /** Provision the AWS-managed web search connector behind a gateway. */
  readonly webSearch: boolean;
  /** OIDC discovery URL of the Okta authorization server. The runtime's
   *  inbound JWT authorizer validates every invocation's Bearer token
   *  against this. */
  readonly oidcDiscoveryUrl: string;
  /** Audience (`aud`) the inbound JWT must carry - the Okta AS audience
   *  (e.g. api://internal). The authorizer rejects tokens for any other
   *  audience. */
  readonly oidcAllowedAudience: string;
  /** Base URL of the internal directory API. The in-VM proxy forwards
   *  the user's calls here after the OBO exchange. */
  readonly internalDirectoryUrl: string;
  /** Base URL of the internal ticket API, the second OBO target. */
  readonly internalTicketsUrl: string;
}

export class RuntimeStack extends Stack {
  public readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);

    const { region, account } = Stack.of(this);
    const {
      imageTag,
      tracing,
      webSearch,
      oidcDiscoveryUrl,
      oidcAllowedAudience,
      internalDirectoryUrl,
      internalTicketsUrl,
      exchangeProvider,
    } = props;
    const stackName = this.stackName;

    const containerUri = `${account}.dkr.ecr.${region}.amazonaws.com/${REPO_NAME}:${imageTag}`;
    const runtimeLogGroupArn = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`;

    const role = new Role(this, 'RuntimeRole', {
      assumedBy: new ServicePrincipal(AGENTCORE_PRINCIPAL),
      description: 'Runtime role for the Slack agent AgentCore runtime.',
    });

    // Pull the agent image. GetAuthorizationToken is account-wide by design;
    // the layer reads are scoped to this one repository.
    role.addToPolicy(
      new PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: [`arn:aws:ecr:${region}:${account}:repository/${REPO_NAME}`],
      }),
    );

    // CloudWatch logs the runtime auto-creates per session.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
        resources: [runtimeLogGroupArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${runtimeLogGroupArn}:log-stream:*`],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${region}:${account}:log-group:*`],
      }),
    );

    // Deliberately no ReadOnlyAccess or other blanket policy. The agent runs
    // arbitrary bash, so whatever this role can do, a prompt injection can do.
    // ReadOnlyAccess would include dynamodb:Scan on every table in the account,
    // which is where both internal APIs keep their data - the OBO boundary
    // would be decorative. Everything below is scoped to one purpose.

    // Bedrock model invocation. Unscoped so a cross-region inference profile
    // resolves to whichever regional model backs it without listing every
    // sub-arn. The `bedrock-mantle` actions are the OpenAI-compatible endpoint
    // that src/agent.ts uses for OpenAI model ids: the SDK signs a bearer token
    // locally and Mantle authorizes it as CallWithBearerToken.
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
          'bedrock-mantle:CallWithBearerToken',
          'bedrock-mantle:CreateInference',
        ],
        resources: ['*'],
      }),
    );

    // The Slack bot token, and nothing else under that prefix. The signing
    // secret sits beside it, but only the trigger may read that: the agent runs
    // arbitrary shell under this role, and whoever holds the signing secret can
    // forge a mention as any signed-in user.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${region}:${account}:parameter/${stackName}/secrets/shared/slack-bot-token`,
        ],
      }),
    );

    // AgentCore Identity, split by resource:
    //   - the workload-identity actions authorize against the directory,
    //   - GetResourceOauth2Token (the OBO exchange) authorizes against the
    //     token-vault credential provider, which is what actually controls
    //     which providers the agent can use.
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          // NOT GetWorkloadAccessTokenForUserId: it takes an unverified user
          // id, so the agent could mint a token as anyone. The runtime does not
          // need it - its workload token comes from the inbound JWT.
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/*`,
        ],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['bedrock-agentcore:GetResourceOauth2Token'],
        resources: [
          // The OBO exchange authorizes against BOTH the token-vault credential
          // provider AND the runtime's own workload identity (the caller). It
          // must be allowed on both, or AgentCore denies GetResourceOauth2Token
          // on the workload-identity resource. Only the exchange provider is
          // allowed, so the agent cannot reach other providers in the vault.
          `arn:aws:bedrock-agentcore:${region}:${account}:token-vault/default`,
          `arn:aws:bedrock-agentcore:${region}:${account}:token-vault/default/oauth2credentialprovider/${exchangeProvider}`,
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/*`,
        ],
      }),
    );
    // Required, and not obvious: AgentCore Identity reads the credential
    // provider's client secret using OUR credentials, not its own, so the OBO
    // exchange fails with AccessDenied on this secret without it. Verified by
    // removing it and watching the exchange break.
    // Scoped to the exchange provider's own secret. The agent runs arbitrary
    // shell under this role, so granting the whole `bedrock-agentcore-identity!`
    // prefix would also hand it the sign-in client's secret, which it never
    // needs. AgentCore appends a random suffix to the secret name.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${region}:${account}:secret:bedrock-agentcore-identity!default/oauth2/${exchangeProvider}-*`,
        ],
      }),
    );

    // Observability. AWS's OpenTelemetry distro (loaded in the Dockerfile CMD)
    // exports Strands' spans and metrics to X-Ray and CloudWatch when
    // AGENT_OBSERVABILITY_ENABLED is set; Transaction Search turns them into
    // the Agent, Session and Trace views in the CloudWatch GenAI Observability
    // console (enable it once per region, see the Makefile). When tracing is
    // off we flip the standard OTEL_SDK_DISABLED kill switch so the same image
    // is a no-op.
    const observabilityEnv: Record<string, string> = tracing
      ? { AGENT_OBSERVABILITY_ENABLED: 'true' }
      : { OTEL_SDK_DISABLED: 'true' };
    if (tracing) {
      role.addToPolicy(
        new PolicyStatement({
          actions: ['xray:PutTraceSegments', 'xray:PutSpans', 'xray:PutSpansForIndexing'],
          resources: ['*'],
        }),
      );
    }

    const runtime = new CfnRuntime(this, 'SlackRuntime', {
      agentRuntimeName: 'slack_agent',
      description: 'Slack-triggered agent on AgentCore',
      roleArn: role.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      // Inbound auth: every invocation must carry a Bearer JWT issued by
      // our Okta AS, with aud = the AS audience. This is what makes the
      // user's identity *proven* (not asserted) and gives the OBO exchange
      // its subject token.
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: oidcDiscoveryUrl,
          allowedAudience: [oidcAllowedAudience],
        },
      },
      environmentVariables: {
        AGENT_SHARED_SECRETS_SSM_PREFIX: `/${stackName}/secrets/shared`,
        INTERNAL_DIRECTORY_URL: internalDirectoryUrl,
        INTERNAL_TICKETS_URL: internalTicketsUrl,
        ...(webSearch ? { WEB_SEARCH_GATEWAY_URL: this.addWebSearchGateway(role) } : {}),
        ...observabilityEnv,
      },
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: IDLE_TIMEOUT_SECONDS,
      },
    });

    // AgentCore validates that this role can pull the image while creating the
    // runtime, so the role's inline policy has to exist first. Without this the
    // two resources update in parallel and the first deploy fails on ECR.
    runtime.node.addDependency(role.node.findChild('DefaultPolicy'));

    this.runtimeArn = runtime.attrAgentRuntimeArn;
  }

  // An AgentCore Gateway with the AWS-managed `web-search` connector as its only
  // target. The gateway authenticates callers with IAM, so the runtime role just
  // needs InvokeGateway on it and there is no API key anywhere. Returns the URL
  // the agent's web_search tool posts to.
  private addWebSearchGateway(runtimeRole: Role): string {
    const { region, account } = Stack.of(this);

    // The service role the gateway assumes to call the connector. Its trust
    // policy is scoped to gateways in this account; the ARN has to be a pattern
    // because the gateway does not exist yet when the role is made.
    const gatewayRole = new Role(this, 'WebSearchGatewayRole', {
      assumedBy: new ServicePrincipal(AGENTCORE_PRINCIPAL, {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${region}:${account}:gateway/*` },
        },
      }),
      description: 'Assumed by the web search gateway to call the managed connector.',
    });
    gatewayRole.addToPolicy(
      new PolicyStatement({
        actions: ['bedrock-agentcore:InvokeWebSearch'],
        resources: [`arn:aws:bedrock-agentcore:${region}:aws:tool/web-search.v1`],
      }),
    );
    gatewayRole.addToPolicy(
      new PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [`arn:aws:bedrock-agentcore:${region}:${account}:gateway/*`],
      }),
    );

    const gateway = new CfnGateway(this, 'WebSearchGateway', {
      name: 'slack-agent-web-search',
      authorizerType: 'AWS_IAM',
      protocolType: 'MCP',
      protocolConfiguration: { mcp: { supportedVersions: ['2025-03-26'] } },
      roleArn: gatewayRole.roleArn,
    });
    // Target name is part of the tool name the agent calls: web-search___WebSearch.
    new CfnGatewayTarget(this, 'WebSearchTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: 'web-search',
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: 'web-search' },
            configurations: [{ name: 'WebSearch', parameterValues: {} }],
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });

    runtimeRole.addToPolicy(
      new PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [gateway.attrGatewayArn],
      }),
    );

    new CfnOutput(this, 'WebSearchGatewayUrl', { value: gateway.attrGatewayUrl });
    return gateway.attrGatewayUrl;
  }
}
