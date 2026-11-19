# Durable outbox operations

Vibe JIRA writes domain events to `outbox_events` in the same PostgreSQL transaction as each product mutation. The `outbox-worker` service claims every non-notification topic with `FOR UPDATE SKIP LOCKED`, records an idempotent `internal-ledger` delivery, and only then marks the source event published. Notification topics remain owned by `notification-worker`.

## Normal operation

- `docker compose ps` should report `outbox-worker` as healthy.
- Organization administrators can inspect queue depth, oldest pending time, worker heartbeat, delivery volume, and dead letters at `/administration/outbox`.
- Structured delivery summaries are written to stdout as `outbox.delivery` events.
- `OUTBOX_POLL_MS`, `OUTBOX_MAX_ATTEMPTS`, and `OUTBOX_HEALTH_MAX_AGE_SECONDS` control polling, quarantine, and container-health thresholds.

The worker retries failed deliveries with exponential delay. An event is quarantined after the configured maximum attempts. Successful replay is safe because `(source_outbox_id, consumer)` is unique in `outbox_deliveries`.

## Dead-letter response

1. Open **Administration → Outbox delivery** and inspect the topic and last error.
2. Correct the underlying payload producer or delivery dependency before retrying.
3. Select **Retry**. The action is organization-scoped and recorded as `outbox.retried` in the audit log.
4. Refresh until pending returns to zero and the event no longer appears under dead letters.
5. If the event fails again, preserve its ID, topic, timestamps, and worker logs for incident review.

Do not edit `published_at`, delete outbox rows, or change delivery-ledger rows during normal recovery. Those operations bypass idempotency and audit evidence.

## Worker recovery

Restarting or replacing `outbox-worker` is safe. Unpublished events stay durable in PostgreSQL, expired claims need no cleanup because row locks are transaction-scoped, and another worker can continue immediately. A stale heartbeat makes the container unhealthy after the configured threshold but does not make the web application unavailable.

Useful checks:

```sh
docker compose ps
docker compose logs --tail=100 outbox-worker
docker compose restart outbox-worker
```

After recovery, confirm the worker is healthy and the pending count is draining from `/administration/outbox`.
