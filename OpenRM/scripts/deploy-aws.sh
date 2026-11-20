#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

AWS_REGION="${AWS_REGION:-us-east-2}"
CLOUDFRONT_REGION="${CLOUDFRONT_REGION:-us-east-1}"
AWS_PROFILE="${AWS_PROFILE:-openrm-deployer}"
STACK_NAME="${STACK_NAME:-openrm-demo}"
PROJECT_NAME="${PROJECT_NAME:-openrm}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-demo}"
WAIT_FOR_INVALIDATION="${WAIT_FOR_INVALIDATION:-true}"

AWS_ARGS=(--profile "${AWS_PROFILE}" --region "${AWS_REGION}")
CLOUDFRONT_ARGS=(--profile "${AWS_PROFILE}" --region "${CLOUDFRONT_REGION}")

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI v2 is required. Install it, authenticate, then rerun this command." >&2
  echo "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required to build the React application." >&2
  exit 1
fi

ACCOUNT_ID="$(aws "${AWS_ARGS[@]}" sts get-caller-identity --query Account --output text)"
CALLER_ARN="$(aws "${AWS_ARGS[@]}" sts get-caller-identity --query Arn --output text)"

echo "Deploying OpenRM preview"
echo "  Account:     ${ACCOUNT_ID}"
echo "  Caller:      ${CALLER_ARN}"
echo "  Region:      ${AWS_REGION}"
echo "  Stack:       ${STACK_NAME}"
echo

cd "${PROJECT_DIR}"

npm ci
npm run build

stack_output() {
  local output_key="$1"
  aws "${AWS_ARGS[@]}" cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue | [0]" \
    --output text
}

BUCKET_NAME="$(stack_output BucketName)"
DISTRIBUTION_ID="$(stack_output DistributionId)"
SITE_URL="$(stack_output SiteUrl)"

if [[ -z "${BUCKET_NAME}" || "${BUCKET_NAME}" == "None" ]]; then
  echo "CloudFormation did not return a deployment bucket." >&2
  exit 1
fi

aws "${AWS_ARGS[@]}" s3 sync "${PROJECT_DIR}/dist/" "s3://${BUCKET_NAME}/" \
  --delete \
  --exclude "index.html" \
  --cache-control "public,max-age=31536000,immutable" \
  --only-show-errors

aws "${AWS_ARGS[@]}" s3 cp "${PROJECT_DIR}/dist/index.html" "s3://${BUCKET_NAME}/index.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "no-cache,no-store,must-revalidate" \
  --only-show-errors

INVALIDATION_ID="$(aws "${CLOUDFRONT_ARGS[@]}" cloudfront create-invalidation \
  --distribution-id "${DISTRIBUTION_ID}" \
  --paths "/*" \
  --query Invalidation.Id \
  --output text)"

if [[ "${WAIT_FOR_INVALIDATION}" == "true" ]]; then
  echo "Waiting for CloudFront invalidation ${INVALIDATION_ID}..."
  aws "${CLOUDFRONT_ARGS[@]}" cloudfront wait invalidation-completed \
    --distribution-id "${DISTRIBUTION_ID}" \
    --id "${INVALIDATION_ID}"
fi

echo
echo "Deployment complete"
echo "  URL:          ${SITE_URL}"
echo "  S3 bucket:    ${BUCKET_NAME}"
echo "  Distribution: ${DISTRIBUTION_ID}"
