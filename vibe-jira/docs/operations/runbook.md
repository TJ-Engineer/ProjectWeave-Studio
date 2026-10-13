# Vibe JIRA operator runbook

## Pin and launch

Use an immutable semantic-version or digest, never `latest`:

```sh
export VIBE_IMAGE=ghcr.io/OWNER/REPOSITORY@sha256:REPLACE_ME
cp .env.example .env
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:3000/health/ready
```

Set long random database, session, object-storage, OIDC, and metrics secrets. Put TLS in front of the application, set `PUBLIC_URL` to that HTTPS origin, and set `TRUST_PROXY=true` only when the proxy replaces forwarded headers. Restrict PostgreSQL, S3, ClamAV, and metrics to the operator network.

## Backup and retention

Run `infra/operations/backup.sh /approved/backup/path` during a maintenance window. It pauses web/workers, takes a PostgreSQL custom-format dump, stops object storage for a consistent private-volume archive, records checksums plus build identity, and restarts only services that were running. Encrypt backups, replicate them off-host, and apply the organization's retention policy. PostgreSQL point-in-time recovery requires a separately managed WAL archive; this snapshot script is not a WAL solution.

Test restoration regularly with `infra/operations/recovery-drill.sh`. The drill creates a separate Compose project and volumes, restores the snapshot, runs migrations, checks readiness, compares project/issue/attachment counts, and downloads every active clean attachment to verify its byte length before destroying only its temporary project.

## Upgrade

1. Read release notes and confirm the backup, database version, available disk, and rollback image digest.
2. Run a recovery drill and record its output.
3. Pull the pinned image. Stop web and workers so no writes race the schema boundary.
4. Run the one-shot `migrate` service. Migrations are checksummed, ordered, transactional, and never edited after release.
5. Start workers and web, then inspect `/health/ready`, `/health/metrics`, logs, the outbox UI, and a representative attachment.
6. Keep the pre-upgrade backup and previous image until the observation window closes.

CI upgrades a schema stopped at the previous release boundary before running the PostgreSQL suite. It also migrates a clean database.

## Rollback

Application rollback is safe only when the prior binary is compatible with the upgraded schema. Prefer forward repair. If release notes permit binary rollback, stop web/workers and start the previous immutable digest. If schema rollback is required, create a forensic copy of the failed state, provision empty database/object volumes, restore the pre-upgrade backup with `CONFIRM_RESTORE=RESTORE infra/operations/restore.sh BACKUP_DIRECTORY`, and validate counts plus attachments before reopening traffic.

## Secret rotation

- Rotate database/object/OIDC credentials at their provider, update injected secrets, and recreate only affected containers.
- Rotating `SESSION_SECRET` intentionally signs every user out.
- Keep overlapping object-store credentials until all containers use the new key, then revoke the old key.
- Never put secret values in tickets, logs, images, Compose files, or backup manifests.

## Incident checks

1. Capture UTC time, build version/revision from `/health/live`, and a correlation ID.
2. Check readiness, database pool gauges, outbox age/dead letters, failed jobs, disk, and object-store/ClamAV health.
3. Preserve logs and audit rows without copying issue descriptions or credentials.
4. Drain traffic before container replacement. Workers stop claiming new work on `SIGTERM` and complete the current batch.
5. For suspected compromise, rotate credentials, invalidate sessions, preserve evidence, and restore only after the exposure path is closed.
