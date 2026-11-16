import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Construct } from "constructs";

export interface OpenRmRegistryStackProps extends cdk.StackProps {
  readonly environmentName: string;
}

export class OpenRmRegistryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpenRmRegistryStackProps) {
    super(scope, id, props);

    const apiRepository = this.createRepository("ApiRepository", "api", props.environmentName);
    const webRepository = this.createRepository("WebRepository", "web", props.environmentName);

    new cdk.CfnOutput(this, "ApiRepositoryUri", {
      description: "Push the API image here, then deploy by immutable sha256 digest.",
      value: apiRepository.repositoryUri,
    });
    new cdk.CfnOutput(this, "WebRepositoryUri", {
      description: "Push the web image here, then deploy by immutable sha256 digest.",
      value: webRepository.repositoryUri,
    });
  }

  private createRepository(
    id: string,
    component: string,
    environmentName: string,
  ): ecr.Repository {
    const repository = new ecr.Repository(this, id, {
      repositoryName: `openrm-${environmentName}-${component}`,
      encryption: ecr.RepositoryEncryption.AES_256,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      emptyOnDelete: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          description: "Expire untagged build layers after seven days",
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(7),
          rulePriority: 1,
        },
        {
          description: "Retain the newest 30 release images",
          tagStatus: ecr.TagStatus.ANY,
          maxImageCount: 30,
          rulePriority: 2,
        },
      ],
    });
    return repository;
  }
}
