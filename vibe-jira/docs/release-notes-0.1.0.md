# Vibe JIRA 0.1.0 — Release 1

- Status: Release candidate approved and published; production activation pending
- Release date: 2026-10-13
- Release owner: TJ The Test Director
- Release tag/revision: `v0.1.0` / `9d04490227bd405b37332fdadd58938276a44df3`
- Release image: `ghcr.io/tj-engineer/vibe-jira@sha256:90a72b2133389f5e5927ccf93f87ac393946909c21bb24548c465c75dad9dc55`
- Release workflow: [successful tag run, attempt 2](https://github.com/TJ-Engineer/ProjectWeave-Studio/actions/runs/38491265813/attempts/2)

Release 1 is the first supported Vibe JIRA release. It delivers the single-organization Kanban product described in `IMPLEMENTATION_PLAN.md`, including issue lifecycle and hierarchy, workflow-aware boards, collaboration, search, administration, reporting, teams, OIDC, operational telemetry, private attachments, and recovery tooling.

## Database migrations

Release 1 creates and upgrades the schema through migration `0022_teams.sql`. Applied migration files are checksummed and must not be edited after deployment.

- `0001`–`0004`: foundation, projects/issues, hierarchy, labels, and lifecycle.
- `0005`–`0008`: server-owned ordering, WIP limits, realtime invalidation, and scale indexes.
- `0009`–`0013`: comments/watchers, notifications, secure attachments, PostgreSQL search, and saved filters.
- `0014`–`0018`: durable outbox, audit retention, administration, CSV jobs, and reporting history.
- `0019`: persistent request-rate limiting.
- `0020`: invitations, account activation state, and OIDC identity mapping.
- `0021`: issue estimate and due-date fields.
- `0022`: teams, team membership, and team-based project roles.

Run the one-shot migration service while web and worker processes are stopped. CI verifies a clean migration and an upgrade from the previous schema boundary.

## Configuration changes

Production deployment requires values derived from `.env.example`:

- Replace all database, session, object-storage, OIDC, demo-user, and metrics placeholders with managed secrets.
- Set `PUBLIC_URL` to the exact external HTTPS origin.
- Set `TRUST_PROXY=true` only behind a trusted proxy that replaces forwarded headers.
- Configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and, when required, `OIDC_CLIENT_SECRET`; register `${PUBLIC_URL}/api/v1/auth/oidc/callback`.
- Keep `OIDC_AUTO_PROVISION=false` unless domain-restricted automatic provisioning is approved.
- Set `ALLOW_PASSWORD_AUTH=false` for production unless a documented break-glass exception is approved.
- Set immutable `APP_VERSION` and `APP_REVISION` values and protect `/health/metrics` with `METRICS_TOKEN` when it crosses a trust boundary.
- Provide private S3-compatible object storage and ClamAV; do not expose PostgreSQL, object storage, ClamAV, or metrics publicly.

## Compatibility and rollback

There is no previous compatible Vibe JIRA application image because `0.1.0` is the initial supported release. A binary rollback target is therefore not applicable.

Before launch, create and verify a quiescent PostgreSQL/object-storage backup. If launch fails after schema migration, preserve the failed state, restore the verified pre-launch snapshot into clean volumes, and correct the release forward. Do not reverse migrations in place.

## Residual risks and required approvals

- Human VoiceOver/Safari and final visual contrast-state validation passed on the local candidate. Promotion changed CI/repository packaging and removed unused npm/Corepack/Yarn tooling from the runtime image; it did not change UI source. The exact release tag then passed the complete three-browser automation matrix before publication.
- The published image currently targets Linux/AMD64. An ARM64 deployment requires a separately built and verified multi-platform release.
- The production host, capacity budget, public origin, identity provider, TLS/reverse proxy, secret store, backup destination, monitoring receivers, and support owners are deployment decisions.
- Local password authentication is intentionally convenient for development and must not remain enabled in production without an accepted exception.
- Release-sized performance evidence is currently local; repeat it on the selected production hardware if its capacity differs materially.
- Outbox age/dead letters, failed jobs, error rate, latency, storage/disk, and backup freshness require active production alerts.

## Proposed observation window

Use a minimum 24-hour elevated-observation window after traffic is enabled; the release owner may extend it for low-volume deployments so that representative activity occurs.

During the window:

1. Confirm readiness and worker health continuously.
2. Review error rate, p95 latency, database pool use, outbox age/dead letters, failed jobs, disk, and backup freshness.
3. Exercise sign-in, project/issue creation, a board move, comment/notification delivery, search, report loading, and attachment upload/download.
4. Keep the verified pre-launch backup until the release owner closes the window.

Observation owner: `PENDING`  
Window start/end: `PENDING`  
Exit decision and evidence: `PENDING`
