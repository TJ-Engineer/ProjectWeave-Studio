# Deploy the OpenRM wireframe to AWS

This deployment keeps the S3 bucket private and serves the React application
through CloudFront over HTTPS. CloudFront uses Origin Access Control (OAC) to
read the bucket, so the S3 website endpoint and public bucket access are not
used.

## Resources created

- One private, encrypted, versioned S3 bucket
- One CloudFront Origin Access Control
- One CloudFront distribution using the default CloudFront HTTPS hostname
- One CloudFront response-headers policy
- One S3 bucket policy restricted to that CloudFront distribution

Normal AWS charges for S3 storage, CloudFront requests, and data transfer may
apply. The default `PriceClass_100` limits the distribution to CloudFront's
lower-cost edge-location set.

## 1. Install and authenticate the AWS CLI

Install AWS CLI v2 using the
[official AWS instructions](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).

For an AWS IAM Identity Center account, configure an SSO profile:

```bash
aws configure sso
aws sso login --profile YOUR_PROFILE
aws --profile YOUR_PROFILE sts get-caller-identity
```

For a non-SSO development account, use your organization's approved credential
method. AWS CLI v2.32 and later can use browser-based temporary credentials:

```bash
aws login --profile openrm-demo --region us-east-2
```

Avoid long-lived root-account access keys.

Verify the account number and ARN before provisioning:

```bash
AWS_PROFILE=openrm-demo aws sts get-caller-identity
```

Confirm the selected Region in **AWS Settings > View all projects > Overview >
Additional Info > Region** before provisioning. This project targets US East
(Ohio), `us-east-2`.

For a new AWS project authenticated through its managed
`AccountFullAccessRole` (or an advanced AWS account authenticated as root),
provision the demo and bootstrap the content-only deployment role once:

```bash
npm run provision:aws
```

The temporary project administration session creates the S3/CloudFront stack and
`OpenRMDeploymentRole`. The persistent role can only read the exact stack,
upload files to the exact demo bucket, and invalidate the CloudFront
distribution carrying the matching OpenRM tags. It cannot create or modify
infrastructure, IAM, databases, or unrelated AWS resources. Subsequent content
deployments use the `openrm-deployer` profile.

The provisioning script logs out the temporary project administration session when it
finishes, including when an error stops the script.

## 2. Deploy content updates

From this project directory:

```bash
aws login --profile openrm-demo --region us-east-2
npm run deploy:aws
aws logout --profile openrm-demo
```

Optional settings:

```bash
AWS_PROFILE=openrm-deployer \
AWS_REGION=us-east-2 \
CLOUDFRONT_REGION=us-east-1 \
STACK_NAME=openrm-demo \
PROJECT_NAME=openrm \
ENVIRONMENT_NAME=demo \
npm run deploy:aws
```

`CLOUDFRONT_REGION=us-east-1` is limited to CloudFront's global API. The S3 and
CloudFormation resources remain in the project's selected Region, `us-east-2`.

The source login supplies temporary credentials for assuming the restricted
role; deployment commands run through `openrm-deployer`. The script waits for
the cache invalidation to finish, then prints the HTTPS URL.

## Subsequent updates

Run the same command. It uploads the new Vite build and invalidates CloudFront;
the restricted role cannot change the infrastructure. Hashed assets receive a
one-year immutable cache policy; `index.html` is always revalidated.

Infrastructure changes are deliberately separate and require a newly
authenticated administrative session plus an explicit review of the
CloudFormation change set.

## Verify

After deployment:

```bash
curl -I "$(AWS_PROFILE=YOUR_PROFILE aws cloudformation describe-stacks \
  --stack-name openrm-demo \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue | [0]" \
  --output text)"
```

Confirm that the result is `HTTP/2 200` and includes the configured security
headers.

## Observability boundary

The initial static preview does not enable CloudFront request access logging.
Before production or regulated traffic, configure standard logging v2 with an
encrypted destination that is compatible with the project's selected-Region
constraints. Use CloudTrail separately for management-plane changes; request
logs and CloudTrail answer different audit questions and should not be treated
as substitutes.

## Remove the demo

The S3 bucket has a `Retain` deletion policy to prevent accidental data loss.
To remove everything, empty the stack's bucket first, delete the CloudFormation
stack, and then delete the retained empty bucket. Resolve the exact bucket name
from the stack outputs before running any deletion command.

## Custom domain

The initial deployment uses the standard `*.cloudfront.net` URL. Adding a
custom hostname requires an ACM certificate in `us-east-1`, a CloudFront alias,
and a DNS record. Keep that as a separate change after the base deployment is
working.
