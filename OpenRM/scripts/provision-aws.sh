#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

AWS_REGION="${AWS_REGION:-us-east-2}"
CLOUDFRONT_REGION="${CLOUDFRONT_REGION:-us-east-1}"
SOURCE_PROFILE="${SOURCE_PROFILE:-openrm-demo}"
STACK_NAME="${STACK_NAME:-openrm-demo}"
PROJECT_NAME="${PROJECT_NAME:-openrm}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-demo}"
PRICE_CLASS="${PRICE_CLASS:-PriceClass_100}"

read -r ACCOUNT_ID CALLER_ARN < <(aws sts get-caller-identity \
  --profile "${SOURCE_PROFILE}" \
  --region "${AWS_REGION}" \
  --query '[Account, Arn]' \
  --output text)

case "${CALLER_ARN}" in
  "arn:aws:iam::${ACCOUNT_ID}:root"|"arn:aws:sts::${ACCOUNT_ID}:assumed-role/AccountFullAccessRole/"*)
    ;;
  *)
    echo "Provisioning expected the project administration profile, got ${CALLER_ARN}." >&2
    echo "Expected the project root identity or managed AccountFullAccessRole." >&2
    echo "Refusing to provision from an unexpected identity." >&2
    exit 1
    ;;
esac

logout_source_profile() {
  if aws logout --profile "${SOURCE_PROFILE}" >/dev/null 2>&1; then
    echo "Temporary project administration session logged out."
  fi
}

trap logout_source_profile EXIT

echo "Provisioning the OpenRM demo infrastructure once"
echo "  Caller:  ${CALLER_ARN}"
echo "  Region:  ${AWS_REGION}"
echo "  Stack:   ${STACK_NAME}"

CACHE_POLICY_ID="$(aws cloudfront list-cache-policies \
  --profile "${SOURCE_PROFILE}" \
  --region "${CLOUDFRONT_REGION}" \
  --type managed \
  --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='Managed-CachingOptimized'].CachePolicy.Id | [0]" \
  --output text)"

if [[ -z "${CACHE_POLICY_ID}" || "${CACHE_POLICY_ID}" == "None" ]]; then
  echo "Could not resolve the AWS managed CachingOptimized cache policy." >&2
  exit 1
fi

aws cloudformation validate-template \
  --profile "${SOURCE_PROFILE}" \
  --region "${AWS_REGION}" \
  --template-body "file://${PROJECT_DIR}/aws/cloudformation.yml" >/dev/null

aws cloudformation deploy \
  --profile "${SOURCE_PROFILE}" \
  --region "${AWS_REGION}" \
  --template-file "${PROJECT_DIR}/aws/cloudformation.yml" \
  --stack-name "${STACK_NAME}" \
  --parameter-overrides \
    "ProjectName=${PROJECT_NAME}" \
    "EnvironmentName=${ENVIRONMENT_NAME}" \
    "CachePolicyId=${CACHE_POLICY_ID}" \
    "PriceClass=${PRICE_CLASS}" \
  --tags \
    "Project=${PROJECT_NAME}" \
    "Environment=${ENVIRONMENT_NAME}" \
    "ManagedBy=CloudFormation" \
  --no-fail-on-empty-changeset

SOURCE_PROFILE="${SOURCE_PROFILE}" \
AWS_REGION="${AWS_REGION}" \
SITE_STACK_NAME="${STACK_NAME}" \
PROJECT_NAME="${PROJECT_NAME}" \
ENVIRONMENT_NAME="${ENVIRONMENT_NAME}" \
"${SCRIPT_DIR}/bootstrap-aws-role.sh"

AWS_PROFILE=openrm-deployer \
AWS_REGION="${AWS_REGION}" \
STACK_NAME="${STACK_NAME}" \
PROJECT_NAME="${PROJECT_NAME}" \
ENVIRONMENT_NAME="${ENVIRONMENT_NAME}" \
"${SCRIPT_DIR}/deploy-aws.sh"
