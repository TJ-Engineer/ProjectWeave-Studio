# Deployment guide

## Supported topology

Release 1 is a single-organization deployment delivered as one immutable application image. The same image runs the web process, migrations, seed, notification worker, and outbox worker. PostgreSQL, private S3-compatible storage, and ClamAV are persistent dependencies. `compose.yaml` is the supported reference topology; a reverse proxy terminates TLS in production.

## Configure

1. Copy `.env.example` to `.env` and replace every placeholder.
2. Set `PUBLIC_URL` to the exact external HTTPS origin. Set `TRUST_PROXY=true` only when the trusted proxy removes and rewrites forwarded headers.
3. Configure OIDC with `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and, when required, `OIDC_CLIENT_SECRET`. Register `${PUBLIC_URL}/api/v1/auth/oidc/callback` at the provider. Keep `OIDC_AUTO_PROVISION=false` unless domain-bound automatic provisioning is intended.
4. Set `ALLOW_PASSWORD_AUTH=false` for production. Use local passwords only for development or an explicitly accepted break-glass policy.
5. Set an immutable `APP_VERSION` and `APP_REVISION`. Pin third-party images and the Vibe JIRA image by digest.
6. Keep PostgreSQL, object storage, ClamAV, and `/health/metrics` off the public network. Set `METRICS_TOKEN` when metrics cross a trust boundary.

The application container runs as a non-root user with a read-only filesystem and `/tmp` as its only writable runtime path.

## Launch and verify

```sh
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

Open `PUBLIC_URL`, sign in through OIDC, create a disposable project and issue, move the issue, and verify refresh persistence. Confirm the outbox is healthy in `/administration/outbox` and that an uploaded attachment can be downloaded.

## Upgrade and recover

Follow the [operator runbook](./operations/runbook.md). Before an upgrade, create an offline-consistent database/object snapshot and pass `infra/operations/recovery-drill.sh`. Applied migration files are immutable. Prefer forward repair; use the documented restore workflow when a schema rollback is required.

## Development profile

The override keeps the production dependency topology but runs Next.js with hot reload:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

The source tree, a dedicated `node_modules` volume, and a Next cache volume are mounted into the build-stage image. Do not use this profile in production.
