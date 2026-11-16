# Service levels, dashboards, and alerts

## Pilot objectives

| Indicator | Objective | Window |
| --- | ---: | --- |
| API successful response availability | 99.9% | rolling 30 days |
| API p95 latency | ≤ 250 ms | rolling 15 minutes |
| Database readiness | 99.95% | rolling 30 days |
| Connector dead letters | 0 unresolved | continuous |
| Pending connector age | < 15 minutes | continuous |
| Backup verification | successful | daily |
| Recovery rehearsal | RTO ≤ 60 minutes | each release |

The API publishes request/error/latency, outbox, and connector metrics at `/metrics`; administrator JSON status is available at `/api/v1/operations/status`. Structured JSON logs carry request IDs, and `OTEL_EXPORTER_OTLP_ENDPOINT` activates OTLP/HTTP trace export.

Prometheus scrape and alert rules live in `deploy/observability`. Alerts cover API availability, HTTP error-budget burn, connector dead letters, and delivery backlog. Route critical alerts to the on-call channel and warning alerts to the pilot operations queue.
