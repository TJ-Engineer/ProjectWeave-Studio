# API reference

[`openapi.json`](./openapi.json) is the generated OpenAPI 3.1 contract for `/api/v1`. Paths and methods are discovered from route handlers; JSON request bodies reference JSON Schema generated from the Zod definitions in `@vibe/contracts`; file upload uses multipart form data. `npm run openapi:generate` updates the artifact and `npm run openapi:check` fails CI on drift.

The browser API uses the signed `vibe_session` HTTP-only cookie. Software-factory agents use an expiring `Authorization: Bearer vibe_agent_...` credential created by an operator. Agent tokens resolve to an active Vibe JIRA user and therefore receive exactly that user's organization, project, and capability permissions; they do not bypass server authorization.

Mutations enforce same-origin browser requests while header-only non-browser clients are admitted without an `Origin` header. Vulnerable creates require an `Idempotency-Key` header. Errors use a stable `{ error: { code, message, correlationId, fields? } }` shape and return the correlation ID in a response header. See the [software-factory agent guide](./agent-rest-api.md) for token lifecycle and dual-service examples.

Agent tokens are an operator-managed, first-party machine interface. General end-user public API token management and webhooks remain Release 2 scope.
