import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { OpenRmPlatformStack } from "../lib/platform-stack.js";

function template(): Template {
  const app = new cdk.App();
  const stack = new OpenRmPlatformStack(app, "Platform", {
    environmentName: "pilot",
    env: { account: "111111111111", region: "us-east-2" },
  });
  return Template.fromStack(stack);
}

describe("OpenRmPlatformStack", () => {
  it("keeps the database private, encrypted, recoverable, and deletion protected", () => {
    template().hasResourceProperties("AWS::RDS::DBInstance", {
      DBInstanceClass: "db.t4g.micro",
      Engine: "postgres",
      EngineVersion: "17.9",
      PubliclyAccessible: false,
      StorageEncrypted: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 1,
      MultiAZ: false,
    });
  });

  it("runs a single cost-bounded hardened application task on Fargate", () => {
    const synthesized = template();
    synthesized.resourceCountIs("AWS::ECS::Service", 1);
    synthesized.resourceCountIs("AWS::ECS::TaskDefinition", 1);
    synthesized.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 1,
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "ENABLED" }),
      },
    });
    synthesized.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "512",
      Memory: "1024",
      NetworkMode: "awsvpc",
      RequiresCompatibilities: ["FARGATE"],
      RuntimePlatform: {
        CpuArchitecture: "ARM64",
        OperatingSystemFamily: "LINUX",
      },
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "Api",
          ReadonlyRootFilesystem: true,
          LogConfiguration: Match.objectLike({ LogDriver: "awslogs" }),
        }),
        Match.objectLike({
          Name: "Web",
          ReadonlyRootFilesystem: true,
          LogConfiguration: Match.objectLike({ LogDriver: "awslogs" }),
        }),
      ]),
      Volumes: Match.absent(),
    });
  });

  it("grants the task execution role pull-only access to the release repositories", () => {
    const synthesized = template();
    synthesized.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ecr:GetAuthorizationToken",
            Effect: "Allow",
            Resource: "*",
          }),
        ]),
      },
    });
    const policies = JSON.stringify(synthesized.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("ecr:BatchCheckLayerAvailability");
    expect(policies).toContain("ecr:BatchGetImage");
    expect(policies).toContain("ecr:GetDownloadUrlForLayer");
    expect(policies).toContain("repository/openrm-pilot-api");
    expect(policies).toContain("repository/openrm-pilot-web");
  });

  it("keeps controlled objects private, versioned, encrypted, and recoverable after deletion", () => {
    const synthesized = template();
    synthesized.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }),
        ]),
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: "Enabled" },
    });
    const policies = JSON.stringify(synthesized.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("s3:ListBucket");
    expect(policies).not.toContain("s3:GetObject");
    expect(policies).toContain("s3:DeleteObject");
  });

  it("uses Cognito authorization for the clean pilot workspace", () => {
    const synthesized = template();
    synthesized.hasResourceProperties("AWS::Cognito::UserPool", {
      DeletionProtection: "ACTIVE",
      MfaConfiguration: "OPTIONAL",
      UsernameConfiguration: { CaseSensitive: false },
    });
    synthesized.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      GenerateSecret: false,
      PreventUserExistenceErrors: "ENABLED",
    });
    synthesized.hasResourceProperties("AWS::Cognito::UserPoolGroup", {
      GroupName: "administrator",
    });
    synthesized.resourceCountIs("AWS::Cognito::UserPoolGroup", 4);
    for (const role of ["author", "reviewer", "viewer"]) {
      synthesized.hasResourceProperties("AWS::Cognito::UserPoolGroup", {
        GroupName: role,
      });
    }
    const policies = JSON.stringify(synthesized.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("cognito-idp:AdminCreateUser");
    expect(policies).toContain("cognito-idp:AdminGetUser");
    expect(policies).toContain("cognito-idp:AdminAddUserToGroup");
  });

  it("avoids NAT gateways and keeps the database on isolated subnets", () => {
    const synthesized = template();
    synthesized.resourceCountIs("AWS::EC2::NatGateway", 0);
    const subnetGroups = Object.values(synthesized.findResources("AWS::RDS::DBSubnetGroup"));
    expect(subnetGroups).toHaveLength(1);
    const subnetGroup = subnetGroups[0]!;
    expect(subnetGroup.Properties.SubnetIds).toHaveLength(2);
  });

  it("accepts load-balancer traffic only from the CloudFront prefix list", () => {
    const synthesized = template();
    synthesized.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      IpProtocol: "tcp",
      FromPort: 80,
      ToPort: 80,
      SourcePrefixListId: { Ref: "CloudFrontPrefixListId" },
    });
    synthesized.templateMatches(
      Match.not(Match.objectLike({
        Resources: Match.objectLike({
          BroadIngress: Match.objectLike({
            Type: "AWS::EC2::SecurityGroupIngress",
            Properties: Match.objectLike({ CidrIp: "0.0.0.0/0" }),
          }),
        }),
      })),
    );
  });

  it("provides HTTPS at CloudFront and disables caching for API requests", () => {
    template().hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Enabled: true,
        HttpVersion: "http2and3",
        PriceClass: "PriceClass_100",
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: "/api/*", ViewerProtocolPolicy: "redirect-to-https" }),
        ]),
      }),
    });
  });
});
