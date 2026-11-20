#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

AWS_REGION="${AWS_REGION:-us-east-2}"
SOURCE_PROFILE="${SOURCE_PROFILE:-openrm-demo}"
DEPLOY_PROFILE="${DEPLOY_PROFILE:-openrm-deployer}"
STACK_NAME="${DEPLOY_ROLE_STACK_NAME:-openrm-deployer-role}"
ROLE_NAME="${DEPLOY_ROLE_NAME:-OpenRMDeploymentRole}"
SITE_STACK_NAME="${SITE_STACK_NAME:-openrm-demo}"
PROJECT_NAME="${PROJECT_NAME:-openrm}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-demo}"

read -r ACCOUNT_ID CALLER_ARN < <(aws sts get-caller-identity \
  --profile "${SOURCE_PROFILE}" \
  --region "${AWS_REGION}" \
  --query '[Account, Arn]' \
  --output text)

case "${CALLER_ARN}" in
  "arn:aws:iam::${ACCOUNT_ID}:root")
    DEPLOYMENT_PRINCIPAL_ARN="${CALLER_ARN}"
    ;;
  "arn:aws:sts::${ACCOUNT_ID}:assumed-role/AccountFullAccessRole/"*)
    DEPLOYMENT_PRINCIPAL_ARN="$(aws iam get-role \
      --profile "${SOURCE_PROFILE}" \
      --region "${AWS_REGION}" \
      --role-name AccountFullAccessRole \
      --query Role.Arn \
      --output text)"
    ;;
  *)
    echo "Bootstrap expected the project administration profile, got ${CALLER_ARN}." >&2
    echo "Expected the project root identity or managed AccountFullAccessRole." >&2
    echo "Refusing to modify IAM from an unexpected identity." >&2
    exit 1
    ;;
esac

aws cloudformation deploy \
  --profile "${SOURCE_PROFILE}" \
  --region "${AWS_REGION}" \
  --template-file "${PROJECT_DIR}/aws/deployer-role.yml" \
  --stack-name "${STACK_NAME}" \
  --parameter-overrides \
    "RoleName=${ROLE_NAME}" \
    "DeploymentPrincipalArn=${DEPLOYMENT_PRINCIPAL_ARN}" \
    "SiteStackName=${SITE_STACK_NAME}" \
    "ProjectName=${PROJECT_NAME}" \
    "EnvironmentName=${ENVIRONMENT_NAME}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags \
    "Project=${PROJECT_NAME}" \
    "Environment=${ENVIRONMENT_NAME}" \
    "ManagedBy=CloudFormation" \
  --no-fail-on-empty-changeset

ROLE_ARN="$(aws cloudformation describe-stacks \
  --profile "${SOURCE_PROFILE}" \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue | [0]" \
  --output text)"

aws configure set role_arn "${ROLE_ARN}" --profile "${DEPLOY_PROFILE}"
aws configure set source_profile "${SOURCE_PROFILE}" --profile "${DEPLOY_PROFILE}"
aws configure set region "${AWS_REGION}" --profile "${DEPLOY_PROFILE}"
aws configure set role_session_name openrm-deploy --profile "${DEPLOY_PROFILE}"

DEPLOYER_ARN="$(aws sts get-caller-identity \
  --profile "${DEPLOY_PROFILE}" \
  --region "${AWS_REGION}" \
  --query Arn \
  --output text)"

echo "Restricted deployment profile ready"
echo "  Profile: ${DEPLOY_PROFILE}"
echo "  Identity: ${DEPLOYER_ARN}"
