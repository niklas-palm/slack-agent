// Everything between Slack and the runtime: one API Gateway with two routes and
// a Lambda behind each.
//
//   POST /slack/events     the mention arrives; broker the user's token, invoke
//                          the runtime, or park the request and post a sign-in link
//   GET  /oauth2/callback  the user finished signing in; complete the token and
//                          resume the parked request
//
// Plus the standalone workload identity user tokens are brokered against, and
// the table a parked request waits in. Both Lambdas share one role, because they
// do the same brokering.
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { AuthorizationType, LambdaIntegration, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { CfnWorkloadIdentity } from 'aws-cdk-lib/aws-bedrockagentcore';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export interface SlackStackProps extends StackProps {
  /** The AgentCore runtime to invoke. */
  readonly runtimeArn: string;
  /** SSM SecureString paths for the Slack signing secret and bot token. */
  readonly signingSecretParam: string;
  readonly botTokenParam: string;
  /** Standalone workload identity to broker user tokens with. */
  readonly brokerWorkloadName: string;
  /** AgentCore credential provider for sign-in, and the scopes to request. */
  readonly userProvider: string;
  readonly userScopes: string[];
}

export class SlackStack extends Stack {
  constructor(scope: Construct, id: string, props: SlackStackProps) {
    super(scope, id, props);
    const { region, account } = Stack.of(this);
    const { runtimeArn, signingSecretParam, botTokenParam, brokerWorkloadName } = props;
    const { userProvider, userScopes } = props;

    const api = new RestApi(this, 'SlackEventsApi', {
      restApiName: 'slack-agent',
      description: 'Slack events webhook and the OAuth sign-in callback',
      deployOptions: { stageName: 'prod' },
    });
    // Built from the API id rather than api.url: api.url pulls in the stage and
    // deployment, which depend on the methods, which depend on the Lambdas that
    // need this URL. CloudFormation rejects that cycle. The id alone is fine.
    const callbackUrl = `https://${api.restApiId}.execute-api.${region}.amazonaws.com/prod/oauth2/callback`;

    // A first-time user's request waits here while they sign in, keyed by the
    // authorization session. Short TTL, set by the writer.
    const sessions = new Table(this, 'AuthSessions', {
      partitionKey: { name: 'session_uri', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expires_at',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // The runtime's own workload identity is service-linked and unusable by an
    // outside caller, so user tokens are brokered through this one. RETAINed:
    // deleting it would orphan every user's vaulted token. AgentCore only
    // completes a sign-in whose return URL is registered here.
    const broker = new CfnWorkloadIdentity(this, 'BrokerWorkloadIdentity', {
      name: brokerWorkloadName,
      allowedResourceOauth2ReturnUrls: [callbackUrl],
    });
    broker.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const role = new Role(this, 'SlackLambdaRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    // Broker the user's Okta token: mint a workload token for the user, then ask
    // the vault. Scoped to this one workload identity and this one provider.
    role.addToPolicy(
      new PolicyStatement({
        actions: [
          'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
          'bedrock-agentcore:GetResourceOauth2Token',
          'bedrock-agentcore:CompleteResourceTokenAuth',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/${brokerWorkloadName}`,
          `arn:aws:bedrock-agentcore:${region}:${account}:token-vault/default`,
          `arn:aws:bedrock-agentcore:${region}:${account}:token-vault/default/oauth2credentialprovider/${userProvider}`,
        ],
      }),
    );
    // AgentCore reads the provider's client secret with OUR credentials when it
    // talks to Okta, so the caller needs this - for the sign-in provider only.
    // AgentCore appends a random suffix to the secret name.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${region}:${account}:secret:bedrock-agentcore-identity!default/oauth2/${userProvider}-*`,
        ],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${region}:${account}:parameter${signingSecretParam}`,
          `arn:aws:ssm:${region}:${account}:parameter${botTokenParam}`,
        ],
      }),
    );
    // Park a request (events) and claim it atomically (callback); nothing else.
    sessions.grant(role, 'dynamodb:PutItem', 'dynamodb:DeleteItem');

    const environment = {
      RUNTIME_ARN: runtimeArn,
      SESSION_TABLE: sessions.tableName,
      SIGNING_SECRET_PARAM: signingSecretParam,
      BOT_TOKEN_PARAM: botTokenParam,
      BROKER_WORKLOAD_NAME: brokerWorkloadName,
      USER_PROVIDER: userProvider,
      USER_SCOPES: userScopes.join(' '),
      OAUTH_CALLBACK_URL: callbackUrl,
    };
    const lambda = (id: string, file: string, memorySize: number) =>
      new NodejsFunction(this, id, {
        entry: `${__dirname}/../../lambda/slack/${file}`,
        projectRoot: `${__dirname}/../..`,
        depsLockFilePath: `${__dirname}/../../package-lock.json`,
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize,
        timeout: Duration.seconds(15),
        role,
        environment,
        bundling: { target: 'node22' },
      });

    // Slack wants an ack within 3s and this path does several round trips on a
    // cold start; more memory buys proportionally more CPU.
    const events = lambda('SlackEventsFn', 'events.ts', 1024);
    const callback = lambda('CallbackFn', 'callback.ts', 256);
    events.node.addDependency(broker);
    callback.node.addDependency(broker);

    // Auth NONE on both: Slack's HMAC is verified inside the events Lambda, and
    // the callback is where AgentCore redirects the browser.
    api.root
      .addResource('slack')
      .addResource('events')
      .addMethod('POST', new LambdaIntegration(events), {
        authorizationType: AuthorizationType.NONE,
      });
    api.root
      .addResource('oauth2')
      .addResource('callback')
      .addMethod('GET', new LambdaIntegration(callback), {
        authorizationType: AuthorizationType.NONE,
      });

    new CfnOutput(this, 'SlackEventsUrl', { value: `${api.url}slack/events` });
    new CfnOutput(this, 'CallbackUrl', { value: callbackUrl });
  }
}
