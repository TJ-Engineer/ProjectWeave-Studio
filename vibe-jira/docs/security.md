# Security baseline and threat model

Vibe JIRA Release 1 is a single-organization, browser-only application. PostgreSQL, object storage, ClamAV, and the worker network are trusted deployment dependencies. TLS terminates at a configured reverse proxy or load balancer; the application image contains no secrets.

## Identity and sessions

- Production identity uses a provider-neutral OpenID Connect authorization-code flow with PKCE, state, nonce, exact issuer/audience validation, RS256 signature verification, short-lived flow cookies, and verified email claims.
- Set `PUBLIC_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and (for confidential clients) `OIDC_CLIENT_SECRET`. Automatic provisioning is off by default; invited email matching is the default onboarding path. `OIDC_ALLOWED_DOMAIN` can add a domain boundary.
- Local password authentication remains available for development. When OIDC is configured in production it is disabled unless `ALLOW_PASSWORD_AUTH=true` is explicitly set.
- Invitations use a random 256-bit, one-time token. Only its SHA-256 digest is stored; it expires after 72 hours. Activation and deactivation preserve the immutable user ID used by historical records.
- Session cookies are signed, HTTP-only, SameSite=Lax, scoped to `/`, and Secure in production. A plain-HTTP deployment reached through a non-localhost name therefore cannot authenticate; production must use HTTPS.

## Web and API boundary

- Every mutation performs a same-origin check. Requests without `Origin` and `Sec-Fetch-Site` are accepted for non-browser API clients, so bearer-less cookie credentials must not be exposed outside the same controlled origin.
- `x-forwarded-host`, `x-forwarded-for`, and `x-real-ip` are trusted only when `TRUST_PROXY=true`. Enable it only when a trusted proxy strips and rewrites these headers.
- Login, OIDC callback, invitation activation, search, upload, and export paths use PostgreSQL-backed bounded rate limits. Keys are one-way hashed and contain no raw email or address.
- Global response headers deny framing and MIME sniffing, restrict referrers and browser features, isolate opener/resources, and apply a restrictive Content Security Policy. HSTS is emitted by production builds.
- Validation has stable error codes; authorization is repeated in the domain/repository boundary. Tenant IDs and project access are never accepted from an untrusted body as authority.
- Every dynamic request accepts or creates W3C trace context, returns `traceparent`/`x-trace-id`, and uses the trace ID as the default API correlation ID. Structured error logs and audit evidence can therefore be joined without recording request bodies.

## Files, content, and data

- Attachments have count, size, declared type, and magic-byte controls; ClamAV gates private S3-compatible storage and downloads use short-lived signed URLs.
- Issue descriptions use a constrained Markdown parser and React element rendering for headings, bold, inline code, lists, and HTTP/HTTPS/mail links. Raw HTML is never interpreted, unsafe schemes become text, and no `dangerouslySetInnerHTML` path exists.
- Passwords use Node scrypt with per-password salts. Secrets belong in environment injection or Docker secrets and must be rotated using the operations runbook.
- Audit records include actor, target, correlation ID, and retention policy. Outbox and data jobs use bounded retry/dead-letter states.

## Residual risks

- The database rate limiter is intentionally simple and protects application endpoints, not volumetric network attacks; the reverse proxy must also enforce connection/body limits.
- CSP permits inline script/style because the current Next.js runtime and chart widths require them. Removing these allowances with nonces is a post-Release 1 hardening item.
- The application verifies RS256 OIDC ID tokens only. Providers configured for another algorithm must be reconfigured or explicitly supported and tested before use.
- Email delivery is deployment-owned in Release 1. Administrators must transmit the displayed one-time invitation link through an approved secure channel.
