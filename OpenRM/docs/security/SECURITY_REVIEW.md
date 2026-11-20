# Phase 5 security review

## Automated gates

- Rust formatting, clippy, tests, and RustSec audit.
- JavaScript lint, typecheck, unit/browser tests, and high-severity dependency audit.
- Authentication, project isolation, role denial, stale-write, CORS, security-header, request-size, and append-only database checks.
- Container runs non-root with a read-only filesystem, all capabilities removed, and `no-new-privileges`.
- Production rejects development authentication and missing signing keys.
- Production requires an explicit signing-key identifier and at least 32 bytes of HMAC key material.

## Review findings

| Finding | Severity | Disposition |
| --- | --- | --- |
| Connector base URL could become an SSRF primitive | High | HTTPS origins without embedded credentials, query, or fragment are required; configuration is administrator-only and Jira paths are code-defined. |
| Connector credentials could enter persisted configuration | High | API stores `secret_ref` only; the worker reads `JIRA_API_TOKEN` from deployment secrets. |
| OIDC discovery could be redirected to an insecure endpoint | High | Production issuer and discovered JWKS URLs require HTTPS and reject embedded credentials, query strings, and fragments. |
| OIDC signing keys are loaded at process start | Medium | Pilot identity-key rotations require a rolling API restart and authentication smoke check; automatic refresh is required before high-availability expansion. |
| External failures could retry forever | Medium | Attempts are bounded; rate limits/backoff are explicit; terminal work enters an operator-visible dead letter. |
| API requests lacked resource bounds | Medium | Added 1 MiB body limit and 30-second request timeout. |
| Operational failure was not measurable | Medium | Added Prometheus SLIs, authenticated operations status, OTLP traces, dashboards/alerts configuration. |

No unresolved launch-blocking finding is known for the bounded pilot. An independent penetration test is still an entry criterion for broader regulated production use; its absence must not be represented as completed external assurance.
