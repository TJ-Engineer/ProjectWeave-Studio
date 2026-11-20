# Troubleshooting

## The app is not ready

Run `docker compose ps` and `docker compose logs --tail=200 app migrate seed postgres object-storage clamav`. A live but unready app normally indicates database connectivity or migrations. A restart loop mentioning `.next` means an image/entrypoint mismatch; rebuild the image. Never bypass a migration checksum failure—restore the original migration and ship a new one.

## Sign-in fails

- Confirm `PUBLIC_URL` exactly matches the browser origin and OIDC redirect URI.
- Check OIDC issuer, client ID, client secret, provider clock, verified email claim, invited email, and optional allowed domain.
- A production deployment with OIDC intentionally rejects local passwords unless `ALLOW_PASSWORD_AUTH=true`.
- Repeated attempts can return `RATE_LIMITED`; wait for the reported window and check reverse-proxy limits.

## A project or action is missing

Check organization state, direct project role, team membership, and team project role. Roles are additive and the strongest role wins. A revoked user may still be an active organization member but receive `FORBIDDEN` for the project. Use a correlation ID from the error with the audit view and structured logs.

## Attachments fail

Confirm object storage and ClamAV are healthy and that internal/public storage endpoints differ correctly for container and browser access. Check file size, type, magic bytes, the 20-file issue cap, and scan state. A clean database record with a missing object is a recovery failure; run the recovery verifier/drill before reopening traffic.

## Notifications or jobs stall

Inspect `/administration/outbox`, worker logs, heartbeat age, retries, and dead letters. Correct the dependency or payload problem before retry. CSV job validation errors are downloadable/visible in project data settings and never silently become partial writes under atomic-reject policy.

## Collect useful evidence

Record UTC time, build version/revision, route, user role, correlation ID, status/error code, and sanitized reproduction steps. Do not collect passwords, cookies, invitation tokens, OIDC tokens, issue descriptions, or attachment content in logs or tickets.
