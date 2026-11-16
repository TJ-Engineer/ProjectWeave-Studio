#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";

import { OpenRmPlatformStack } from "../lib/platform-stack.js";
import { OpenRmRegistryStack } from "../lib/registry-stack.js";

const app = new cdk.App();
const selectedRegion = String(
  app.node.tryGetContext("region") ??
    process.env.OPENRM_AWS_REGION ??
    "us-east-2",
);

if (selectedRegion !== "us-east-2") {
  throw new Error(
    `OpenRM production resources must remain in the project's selected Region us-east-2; received ${selectedRegion}.`,
  );
}

const environmentName = app.node.tryGetContext("environment") ?? "pilot";
const env: cdk.Environment = process.env.CDK_DEFAULT_ACCOUNT
  ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: selectedRegion }
  : { region: selectedRegion };

new OpenRmRegistryStack(app, "OpenRmRegistry", {
  env,
  environmentName,
  description: "Immutable OpenRM production container registries",
  terminationProtection: true,
});

new OpenRmPlatformStack(app, "OpenRmPlatform", {
  env,
  environmentName,
  description: "Bounded OpenRM pilot platform in the selected AWS Region",
  terminationProtection: true,
});

cdk.Tags.of(app).add("Project", "openrm");
cdk.Tags.of(app).add("Environment", environmentName);
cdk.Tags.of(app).add("ManagedBy", "CDK");
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
