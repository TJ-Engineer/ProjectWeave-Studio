import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { OpenRmRegistryStack } from "../lib/registry-stack.js";

describe("OpenRmRegistryStack", () => {
  it("keeps release repositories encrypted, immutable, scanned, and retained", () => {
    const app = new cdk.App();
    const stack = new OpenRmRegistryStack(app, "Registry", {
      environmentName: "pilot",
      env: { account: "111111111111", region: "us-east-2" },
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::ECR::Repository", 2);
    template.hasResourceProperties("AWS::ECR::Repository", {
      ImageScanningConfiguration: { ScanOnPush: true },
      ImageTagMutability: "IMMUTABLE",
      LifecyclePolicy: Match.objectLike({ LifecyclePolicyText: Match.anyValue() }),
    });
    const repositories = template.findResources("AWS::ECR::Repository");
    expect(Object.values(repositories).every((resource) => resource.DeletionPolicy === "Retain")).toBe(
      true,
    );
  });
});
