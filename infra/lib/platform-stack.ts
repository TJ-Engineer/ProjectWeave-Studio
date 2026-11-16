import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface OpenRmPlatformStackProps extends cdk.StackProps {
  readonly environmentName: string;
}

const PILOT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";
const PILOT_PROJECT_ID = "00000000-0000-4000-8000-000000000102";

export class OpenRmPlatformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpenRmPlatformStackProps) {
    super(scope, id, props);

    const environmentName = props.environmentName;
    const apiImage = this.imageParameter("ApiImageUri", environmentName, "api");
    const webImage = this.imageParameter("WebImageUri", environmentName, "web");
    const callbackUrl = new cdk.CfnParameter(this, "ApplicationCallbackUrl", {
      type: "String",
      default: "http://localhost:4173/",
      allowedPattern: "^https://[^?#]+/$|^http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?/$",
      description:
        "Exact Cognito callback/logout URL. Deploy once with the local default, then update it to the CloudFront ApplicationUrl output.",
    });
    const cloudFrontPrefixListId = new cdk.CfnParameter(this, "CloudFrontPrefixListId", {
      type: "String",
      allowedPattern: "^pl-[0-9a-f]+$",
      description:
        "ID of com.amazonaws.global.cloudfront.origin-facing in us-east-2. Resolve at deployment time.",
    });
    const originVerifyHeader = new cdk.CfnParameter(this, "OriginVerifyHeader", {
      type: "String",
      noEcho: true,
      minLength: 32,
      allowedPattern: "^[A-Za-z0-9_-]+$",
      description: "Random value shared by CloudFront and the ALB listener.",
    });

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `openrm-${environmentName}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: true } },
      customAttributes: {
        org_id: new cognito.StringAttribute({ minLen: 36, maxLen: 36, mutable: false }),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      userInvitation: {
        emailSubject: "Your OpenRM pilot invitation",
        emailBody:
          "Your OpenRM username is {username} and temporary password is {####}. Sign in and choose a new password.",
      },
    });
    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: `openrm-${environmentName}-web`,
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      enableTokenRevocation: true,
      refreshTokenRotationGracePeriod: cdk.Duration.seconds(30),
      accessTokenValidity: cdk.Duration.minutes(15),
      idTokenValidity: cdk.Duration.minutes(15),
      refreshTokenValidity: cdk.Duration.days(1),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [callbackUrl.valueAsString],
        logoutUrls: [callbackUrl.valueAsString],
      },
    });
    const userPoolDomain = userPool.addDomain("Domain", {
      cognitoDomain: {
        domainPrefix: cdk.Fn.sub(`openrm-${environmentName}-\${AWS::AccountId}`),
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const branding = new cognito.CfnManagedLoginBranding(this, "ManagedLoginBranding", {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(userPoolDomain);
    new cognito.CfnUserPoolGroup(this, "AdministratorGroup", {
      groupName: "administrator",
      description: "OpenRM organization administrators",
      precedence: 1,
      userPoolId: userPool.userPoolId,
    });
    [
      ["AuthorGroup", "author", "OpenRM requirement authors", 2],
      ["ReviewerGroup", "reviewer", "OpenRM reviewers", 3],
      ["ViewerGroup", "viewer", "OpenRM read-only users", 4],
    ].forEach(([id, groupName, description, precedence]) => {
      new cognito.CfnUserPoolGroup(this, String(id), {
        groupName: String(groupName),
        description: String(description),
        precedence: Number(precedence),
        userPoolId: userPool.userPoolId,
      });
    });

    const auditLogs = new s3.Bucket(this, "AccessLogs", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const controlledObjects = new s3.Bucket(this, "ControlledObjects", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      serverAccessLogsBucket: auditLogs,
      serverAccessLogsPrefix: "controlled-objects/",
      lifecycleRules: [{
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        noncurrentVersionExpiration: cdk.Duration.days(30),
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/16"),
      maxAzs: 2,
      natGateways: 0,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    vpc.addFlowLog("FlowLog", {
      destination: ec2.FlowLogDestination.toS3(auditLogs, "vpc-flow"),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });

    const databaseLogGroup = new logs.LogGroup(this, "DatabaseLogs", {
      logGroupName: `/aws/rds/instance/openrm-${environmentName}/postgresql`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const database = new rds.DatabaseInstance(this, "Database", {
      instanceIdentifier: `openrm-${environmentName}`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17_9,
      }),
      credentials: rds.Credentials.fromGeneratedSecret("openrm_admin"),
      databaseName: "openrm",
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      backupRetention: cdk.Duration.days(1),
      deleteAutomatedBackups: false,
      deletionProtection: true,
      copyTagsToSnapshot: true,
      autoMinorVersionUpgrade: true,
      cloudwatchLogsExports: ["postgresql"],
      enablePerformanceInsights: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });
    database.node.addDependency(databaseLogGroup);
    if (!database.secret) {
      throw new Error("The RDS database must expose a generated Secrets Manager secret.");
    }

    const evidenceSigningKey = new secretsmanager.Secret(this, "EvidenceSigningKey", {
      description: "Active HMAC signing key for immutable OpenRM evidence",
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const apiLogs = new logs.LogGroup(this, "ApiLogs", {
      logGroupName: `/openrm/${environmentName}/api`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const webLogs = new logs.LogGroup(this, "WebLogs", {
      logGroupName: `/openrm/${environmentName}/web`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const task = new ecs.FargateTaskDefinition(this, "ApplicationTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminAddUserToGroup",
      ],
      resources: [userPool.userPoolArn],
    }));
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [controlledObjects.bucketArn],
    }));
    task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:DeleteObject"],
      resources: [controlledObjects.arnForObjects("*")],
    }));
    const apiContainer = task.addContainer("Api", {
      image: ecs.ContainerImage.fromRegistry(apiImage.valueAsString),
      cpu: 384,
      memoryReservationMiB: 640,
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogs, streamPrefix: "api" }),
      readonlyRootFilesystem: true,
      user: "10001:10001",
      stopTimeout: cdk.Duration.seconds(60),
      environment: {
        APP_ENV: "production",
        AUTH_MODE: "oidc",
        API_BIND_ADDRESS: "0.0.0.0:8080",
        DATABASE_HOST: database.dbInstanceEndpointAddress,
        DATABASE_PORT: database.dbInstanceEndpointPort,
        DATABASE_NAME: "openrm",
        DATABASE_SSL_MODE: "verify-full",
        DATABASE_SSL_ROOT_CERT: "/etc/ssl/certs/aws-rds-us-east-2-bundle.pem",
        RUN_MIGRATIONS: "true",
        OIDC_ISSUER: cdk.Fn.join("", [
          "https://cognito-idp.",
          cdk.Aws.REGION,
          ".amazonaws.com/",
          userPool.userPoolId,
        ]),
        OIDC_AUDIENCE: userPoolClient.userPoolClientId,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        OBJECT_STORAGE_BUCKET: controlledObjects.bucketName,
        OBJECT_STORAGE_REGION: cdk.Aws.REGION,
        OBJECT_STORAGE_FORCE_PATH_STYLE: "false",
        EVIDENCE_SIGNING_KEY_ID: `${environmentName}-v1`,
        RUST_LOG: "openrm_api=info,tower_http=info",
      },
      secrets: {
        DATABASE_USER: ecs.Secret.fromSecretsManager(database.secret, "username"),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(database.secret, "password"),
        EVIDENCE_SIGNING_KEY: ecs.Secret.fromSecretsManager(evidenceSigningKey),
      },
      healthCheck: {
        command: ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:8080/ready || exit 1"],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });
    apiContainer.addPortMappings({
      name: "api",
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
    });

    const webContainer = task.addContainer("Web", {
      image: ecs.ContainerImage.fromRegistry(webImage.valueAsString),
      cpu: 128,
      memoryReservationMiB: 256,
      logging: ecs.LogDrivers.awsLogs({ logGroup: webLogs, streamPrefix: "web" }),
      readonlyRootFilesystem: true,
      user: "101:101",
      stopTimeout: cdk.Duration.seconds(30),
      environment: {
        OPENRM_AUTH_MODE: "cognito",
        OPENRM_API_BASE_URL: "/",
        OPENRM_ORGANIZATION_ID: PILOT_ORGANIZATION_ID,
        OPENRM_PROJECT_ID: PILOT_PROJECT_ID,
        OPENRM_PROJECT_KEY: "OPENRM",
        OPENRM_PROJECT_NAME: "OpenRM",
        OPENRM_COGNITO_DOMAIN: userPoolDomain.baseUrl(),
        OPENRM_COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "wget --quiet --spider http://127.0.0.1:8081/container-health || exit 1",
        ],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(20),
      },
    });
    webContainer.addPortMappings({
      name: "web",
      containerPort: 8081,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
    });
    webContainer.addContainerDependencies({
      container: apiContainer,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });
    if (!task.executionRole) {
      throw new Error("The application task must have an ECS execution role.");
    }
    for (const component of ["api", "web"]) {
      ecr.Repository.fromRepositoryName(
        this,
        `${component}ReleaseRepository`,
        `openrm-${environmentName}-${component}`,
      ).grantPull(task.executionRole);
    }

    const service = new ecs.FargateService(this, "ApplicationService", {
      cluster,
      taskDefinition: task,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });
    database.connections.allowDefaultPortFrom(service, "PostgreSQL from the OpenRM task only");

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
    });
    loadBalancer.logAccessLogs(auditLogs, "alb");
    loadBalancer.connections.allowFrom(
      ec2.Peer.prefixList(cloudFrontPrefixListId.valueAsString),
      ec2.Port.tcp(80),
      "CloudFront origin-facing servers only",
    );
    const listener = loadBalancer.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: "application/json",
        messageBody: '{"error":"direct origin access is forbidden"}',
      }),
    });
    const originHeader = originVerifyHeader.valueAsString;
    const webTargetGroup = listener.addTargets("WebTargets", {
      port: 8081,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service.loadBalancerTarget({ containerName: "Web", containerPort: 8081 })],
      conditions: [elbv2.ListenerCondition.httpHeader("X-OpenRM-Origin", [originHeader])],
      priority: 100,
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: "/container-health",
        healthyHttpCodes: "200",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
      },
    });

    const origin = new origins.LoadBalancerV2Origin(loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      customHeaders: { "X-OpenRM-Origin": originHeader },
      connectionAttempts: 3,
      connectionTimeout: cdk.Duration.seconds(10),
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });
    const cognitoDomain = userPoolDomain.baseUrl();
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy:
            `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${cognitoDomain}; form-action 'self' ${cognitoDomain}`,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: false,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
            override: true,
          },
        ],
      },
    });
    const dynamicBehavior: cloudfront.BehaviorOptions = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: securityHeaders,
      compress: true,
    };
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `OpenRM ${environmentName} application`,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: securityHeaders,
        compress: true,
      },
      additionalBehaviors: {
        "/api/*": dynamicBehavior,
        "/health": dynamicBehavior,
        "/ready": dynamicBehavior,
        "/openrm-config.json": dynamicBehavior,
        "/assets/*": {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const apiCpuAlarm = new cloudwatch.Alarm(this, "ApiCpuAlarm", {
      metric: service.metricCpuUtilization({ period: cdk.Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    const unhealthyHostsAlarm = new cloudwatch.Alarm(this, "UnhealthyHostsAlarm", {
      metric: webTargetGroup.metrics.unhealthyHostCount({ period: cdk.Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.CompositeAlarm(this, "ServiceHealthAlarm", {
      alarmRule: cloudwatch.AlarmRule.anyOf(apiCpuAlarm, unhealthyHostsAlarm),
      alarmDescription: "OpenRM service requires operator attention.",
    });

    new cdk.CfnOutput(this, "ApplicationUrl", {
      value: `https://${distribution.distributionDomainName}/`,
    });
    new cdk.CfnOutput(this, "CloudFrontDomainName", {
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "CognitoDomain", { value: userPoolDomain.baseUrl() });
    new cdk.CfnOutput(this, "ControlledObjectsBucketName", { value: controlledObjects.bucketName });
    new cdk.CfnOutput(this, "PilotOrganizationId", { value: PILOT_ORGANIZATION_ID });
    new cdk.CfnOutput(this, "PilotProjectId", { value: PILOT_PROJECT_ID });
    new cdk.CfnOutput(this, "DatabaseSecretArn", {
      description: "Reference only; do not print or export the secret value.",
      value: database.secret.secretArn,
    });

    cdk.Validations.of(userPool).acknowledge({
      id: "AwsSolutions-COG2",
      reason:
        "TOTP MFA is enabled but optional for the bounded single-user pilot; make it required before adding broader production users.",
    });
    cdk.Validations.of(userPool).acknowledge({
      id: "AwsSolutions-COG8",
      reason:
        "The bounded single-user pilot uses the Cognito Essentials tier to control cost; enable Plus-tier threat protection before broader production access.",
    });
    cdk.Validations.of(database).acknowledge({
      id: "AwsSolutions-RDS3",
      reason:
        "The bounded pilot uses one RDS instance to control cost. Multi-AZ is mandatory before broader production classification.",
    });
    cdk.Validations.of(database).acknowledge({
      id: "AwsSolutions-RDS11",
      reason:
        "The PostgreSQL endpoint is private and accepts traffic only from the application task security group.",
    });
    cdk.Validations.of(database.node.findChild("Secret")).acknowledge({
      id: "AwsSolutions-SMG4",
      reason:
        "Automatic rotation is gated on ECS task replacement automation so running tasks never retain stale credentials.",
    });
    cdk.Validations.of(evidenceSigningKey).acknowledge({
      id: "AwsSolutions-SMG4",
      reason:
        "Evidence-key rotation requires a controlled ceremony that retains the old verification key.",
    });
    cdk.Validations.of(task).acknowledge({
      id: "AwsSolutions-ECS2",
      reason:
        "Only non-sensitive runtime settings are direct environment variables; credentials and signing material use ECS secret injection.",
    });
    cdk.Validations.of(task.executionRole.node.findChild("DefaultPolicy")).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "Amazon ECR GetAuthorizationToken does not support resource-level permissions; all image-layer actions remain scoped to the two OpenRM release repository ARNs.",
    });
    cdk.Validations.of(auditLogs).acknowledge({
      id: "AwsSolutions-S1",
      reason:
        "This retained bucket is the terminal ALB and VPC-flow log sink; recursive access logging would require an unbounded chain of sinks.",
    });
    cdk.Validations.of(distribution).acknowledge({
      id: "AwsSolutions-CFR1",
      reason: "The bounded pilot is not geo-restricted; Cognito and tenant authorization are the access boundary.",
    });
    cdk.Validations.of(distribution).acknowledge({
      id: "AwsSolutions-CFR2",
      reason:
        "AWS WAF is deferred for the bounded pilot after cost review; the origin accepts only CloudFront network ranges plus a secret header.",
    });
    cdk.Validations.of(distribution).acknowledge({
      id: "AwsSolutions-CFR3",
      reason:
        "CloudFront standard logging is deferred for this low-volume pilot; ALB access logs are retained in the selected Region.",
    });
    cdk.Validations.of(distribution).acknowledge({
      id: "AwsSolutions-CFR4",
      reason:
        "The bounded pilot uses the CloudFront-provided hostname, whose viewer TLS policy is AWS-managed; attach a custom domain and certificate enforcing TLS 1.2 before broader production use.",
    });
    cdk.Validations.of(distribution).acknowledge({
      id: "AwsSolutions-CFR5",
      reason:
        "The pilot uses HTTP to an ALB restricted to CloudFront origin ranges and a secret header; viewer traffic remains TLS-only.",
    });
  }

  private imageParameter(
    id: string,
    environmentName: string,
    component: "api" | "web",
  ): cdk.CfnParameter {
    return new cdk.CfnParameter(this, id, {
      type: "String",
      allowedPattern: `^[0-9]{12}\\.dkr\\.ecr\\.us-east-2\\.amazonaws\\.com/openrm-${environmentName}-${component}@sha256:[0-9a-f]{64}$`,
      description: `Immutable ECR digest URI for the OpenRM ${component} image. Mutable tags are rejected.`,
    });
  }
}
