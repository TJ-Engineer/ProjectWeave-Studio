# Audit trail operations

Organization administrators inspect mutation evidence at `/administration/audit`. The newest events appear first and can be filtered by actor, action substring, target type/ID, correlation ID, and inclusive date range. Results use opaque, filter-bound cursors and never cross the signed-in organization boundary.

Every row records the actor, action, target, structured metadata, request correlation ID, and server timestamp. Use the correlation ID to connect an API response or structured application log with every audit row produced by that request. Audit metadata must not contain passwords, session tokens, attachment bodies, or other secrets.

## Retention

The default retention period is 365 days. An organization administrator can configure 30–3,650 days from the audit page. The update is optimistic-concurrency protected and itself emits both an audit row and a durable outbox event.

The general outbox worker runs a retention sweep on startup and at most once per hour. It deletes only rows whose `created_at` is older than the owning organization's current policy. PostgreSQL backups remain subject to the separate backup-retention policy; changing audit retention does not rewrite existing backup media.

Before shortening retention in production:

1. Confirm legal, contractual, and incident-response requirements.
2. Export or back up evidence that must be preserved.
3. Change the policy and retain the resulting `audit.retention_updated` correlation ID.
4. Verify the worker is healthy on `/administration/outbox`.

Retention pruning is intentionally not exposed as an immediate UI action, avoiding accidental bulk deletion. Stop the outbox worker before a legal hold and preserve the database according to the backup runbook.
