// The two mock internal APIs the agent calls on the user's behalf. Both sit
// behind the same Okta authorization server and are told apart by scope, which
// is what onboarding an API costs: a scope and a rule in Okta, a route here, and
// a line in src/catalog.ts.
//
// They are authorized differently on purpose:
//   directory  "is this person an employee"    a group claim Okta signed
//   tickets    "which records are yours"       the token's subject as the key
// Both decisions belong to the resource server; only the first could ever have
// been expressed in the identity provider.
import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  CfnApi,
  CfnAuthorizer,
  CfnIntegration,
  CfnRoute,
  CfnStage,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export interface InternalApisStackProps extends StackProps {
  /** The Okta authorization server every token must come from. */
  readonly oidcIssuer: string;
  readonly oidcAudience: string;
  /** Who may read the directory. Enforced by the API from the groups claim,
   *  because Okta ignores group conditions on the token-exchange grant. */
  readonly directoryGroup: string;
}

interface ApiSpec {
  name: string;
  entry: string;
  /** Route key and the scope it requires, e.g. ['GET /me', 'directory.read']. */
  routes: Array<[string, string]>;
  environment?: Record<string, string>;
  table?: Table;
}

export class InternalApisStack extends Stack {
  public readonly directoryUrl: string;
  public readonly ticketsUrl: string;

  constructor(scope: Construct, id: string, props: InternalApisStackProps) {
    super(scope, id, props);
    const { region, account } = Stack.of(this);
    const { oidcIssuer, oidcAudience, directoryGroup } = props;

    // An HTTP API whose native JWT authorizer validates signature, issuer,
    // audience and expiry against Okta before the Lambda runs, and whose routes
    // each require one scope. No token validation in our handlers.
    const addApi = (spec: ApiSpec): string => {
      const fn = new NodejsFunction(this, `${spec.name}Fn`, {
        entry: `${__dirname}/../../lambda/${spec.entry}`,
        projectRoot: `${__dirname}/../..`,
        depsLockFilePath: `${__dirname}/../../package-lock.json`,
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 256,
        bundling: { target: 'node22' },
        environment: spec.environment,
      });
      // list, create, read-before-update and update; no scans or deletes.
      spec.table?.grant(
        fn,
        'dynamodb:Query',
        'dynamodb:PutItem',
        'dynamodb:GetItem',
        'dynamodb:UpdateItem',
      );

      const api = new CfnApi(this, `${spec.name}Api`, {
        name: `slack-agent-${spec.name.toLowerCase()}`,
        protocolType: 'HTTP',
      });
      const authorizer = new CfnAuthorizer(this, `${spec.name}Authorizer`, {
        apiId: api.ref,
        name: 'okta-jwt',
        authorizerType: 'JWT',
        identitySource: ['$request.header.Authorization'],
        jwtConfiguration: { issuer: oidcIssuer, audience: [oidcAudience] },
      });
      const integration = new CfnIntegration(this, `${spec.name}Integration`, {
        apiId: api.ref,
        integrationType: 'AWS_PROXY',
        integrationUri: fn.functionArn,
        payloadFormatVersion: '2.0',
      });
      spec.routes.forEach(([routeKey, scope], i) => {
        new CfnRoute(this, `${spec.name}Route${i}`, {
          apiId: api.ref,
          routeKey,
          target: `integrations/${integration.ref}`,
          authorizationType: 'JWT',
          authorizerId: authorizer.ref,
          authorizationScopes: [scope],
        });
      });
      new CfnStage(this, `${spec.name}Stage`, {
        apiId: api.ref,
        stageName: 'prod',
        autoDeploy: true,
      });
      fn.addPermission('ApiGwInvoke', {
        principal: new ServicePrincipal('apigateway.amazonaws.com'),
        sourceArn: `arn:aws:execute-api:${region}:${account}:${api.ref}/*/*`,
      });
      return `https://${api.ref}.execute-api.${region}.amazonaws.com/prod`;
    };

    // Directory: coarse, group-based. No state; the profile is canned. The write
    // route exists to show the ceiling: it needs directory.write, which no Okta
    // rule grants on the exchange grant, so the agent is refused before it gets
    // here.
    this.directoryUrl = addApi({
      name: 'Directory',
      entry: 'internal-directory/handler.ts',
      routes: [
        ['GET /me', 'directory.read'],
        ['PATCH /me', 'directory.write'],
      ],
      environment: { REQUIRED_GROUP: directoryGroup },
    });

    // Tickets: per-record, read/write. Real state, because creating and
    // modifying tickets is the point. The partition key is the verified subject,
    // so a ticket is unreachable from outside its owner's partition.
    const tickets = new Table(this, 'Tickets', {
      partitionKey: { name: 'subject', type: AttributeType.STRING },
      sortKey: { name: 'ticket_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.ticketsUrl = addApi({
      name: 'Tickets',
      entry: 'internal-tickets/handler.ts',
      routes: [
        ['GET /mine', 'tickets.read'],
        ['POST /mine', 'tickets.write'],
        ['PATCH /mine/{id}', 'tickets.write'],
      ],
      environment: { TICKETS_TABLE: tickets.tableName },
      table: tickets,
    });

    new CfnOutput(this, 'DirectoryApiUrl', { value: `${this.directoryUrl}/me` });
    new CfnOutput(this, 'TicketsApiUrl', { value: `${this.ticketsUrl}/mine` });
  }
}
