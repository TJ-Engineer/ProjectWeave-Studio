#!/bin/sh
set -eu

if ! awslocal s3api head-bucket --bucket "${OBJECT_STORAGE_BUCKET}" >/dev/null 2>&1; then
  awslocal s3api create-bucket \
    --bucket "${OBJECT_STORAGE_BUCKET}" \
    --region "${AWS_DEFAULT_REGION}" \
    --create-bucket-configuration "LocationConstraint=${AWS_DEFAULT_REGION}"
fi

awslocal s3api put-bucket-versioning \
  --bucket "${OBJECT_STORAGE_BUCKET}" \
  --versioning-configuration Status=Enabled
