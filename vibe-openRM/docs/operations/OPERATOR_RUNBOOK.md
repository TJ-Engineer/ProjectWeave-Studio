# OpenRM operator runbook

## Service checks

| Signal | Healthy condition | First response |
| --- | --- | --- |
| `/health` | HTTP 200 and expected build SHA | Restart only after checking process logs and recent deploys. |
| `/ready` | HTTP 200 and database available | Check PostgreSQL health, connection limits, TLS, and credentials. |
| `/metrics` | Scrape succeeds every 15 seconds | Check network policy and API process health. |
| Operations status | `healthy`, zero dead letters | Inspect queue age, attempt history, and audit freshness. |
| Error budget | Server error ratio below 0.1% | Correlate request IDs with OTLP traces and database health. |
| API latency | p95 below 250 ms for pilot load | Inspect saturation, slow queries, connector backlog, and pool wait. |

## Jira dead letter

1. Identify the delivery, operation, payload hash, issue key, and final attempt.
2. Confirm whether the response is permanent (permissions, validation, deleted issue) or transient.
3. Correct Jira policy, credential, mapping, or configuration without modifying the stored delivery.
4. Put the connector in `dry_run` if the correction needs validation.
5. Replay through the API/UI as an administrator and confirm a new append-only attempt appears.
6. Close the incident only after queue health and the audit event are verified.

## Database incident

1. Stop write traffic while preserving logs and metrics.
2. Determine whether failover or restore is required.
3. Use the recovery procedure; never edit immutable evidence directly.
4. Run migrations idempotently, then compare controlled-row counts and signed evidence samples.
5. Re-enable traffic gradually and monitor the error budget, latency, and queue ages.

## Security incident

Revoke affected OIDC sessions and external connector credentials, rotate evidence keys if exposed, preserve audit/trace logs, and follow the threat-model response mapping. Treat unknown modifications to append-only tables as a launch-blocking integrity incident.
