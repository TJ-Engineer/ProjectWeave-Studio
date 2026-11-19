# OpenRM threat model

## Protected assets

Controlled requirements and revisions, tenant membership, trace relationships, baselines, approvals, verification evidence, signing keys, connector credentials, audit events, backups, and telemetry are security-sensitive.

## Trust boundaries

1. Browser or automation to the public API through TLS and OIDC.
2. API to PostgreSQL over a private authenticated network.
3. API to the OIDC discovery/JWKS endpoint.
4. Connector worker to Jira over HTTPS with a least-privilege token.
5. API to the OpenTelemetry Collector and metrics scraper.
6. Operators to backup archives and deployment secrets.

## Threats and controls

| Threat | Primary controls | Verification |
| --- | --- | --- |
| Cross-tenant data access | Organization claim checks, project membership, scoped foreign keys, deny-by-default policy | PostgreSQL/API isolation matrix |
| Token forgery or confused issuer | HTTPS-only production issuer/JWKS, discovery match, issuer/audience/expiry validation, RSA-only algorithms | Authentication unit and security smoke tests |
| Evidence tampering | Append-only triggers, exact revision IDs, hashes, HMAC signatures, immutable attempt history | Direct SQL tamper tests and signed export replay |
| Command replay or concurrency loss | Idempotency keys, payload fingerprints, optimistic versions | Runtime replay/conflict matrix |
| Connector SSRF | HTTPS-only origins without embedded credentials, query, or fragment; administrator-only configuration; fixed Jira API paths | Connector validation unit tests |
| Connector credential exposure | Fixed `env:JIRA_API_TOKEN` reference, deployment-secret injection, sensitive authorization headers, no credential value in responses | Configuration/API review |
| Remote API outage/rate limit | Bounded timeouts, `Retry-After`, exponential backoff, max attempts, dead-letter replay | Unit and database-path tests |
| Resource exhaustion | 1 MiB request limit, 30-second timeout, bounded connector payload/list, connection pool limits | Load and oversized-body tests |
| Browser injection/framing | React escaping, API CSP/nosniff/referrer headers, static hosting CSP | Browser and security-header checks |
| Backup theft or corruption | Restricted backup permissions, platform encryption, archive verification, isolated restore rehearsal | Recovery CI job |
| Telemetry leakage | No secrets in spans/metrics, sensitive auth header marking, private collector | Configuration review |

## Residual risks

The initial Jira adapter uses a deployment-scoped bearer token; per-user OAuth delegation is future work. The repository provides a hardened pilot deployment definition but does not itself operate the hosting network, KMS, backup encryption, or alert receiver. An external penetration test remains required before exposing regulated or safety-critical production data beyond the controlled pilot.
