# API reference

[`openapi.json`](./openapi.json) is the generated OpenAPI 3.1 contract for `/api/v1`. Paths and methods are discovered from route handlers; JSON request bodies reference JSON Schema generated from the Zod definitions in `@vibe/contracts`; file upload uses multipart form data. `npm run openapi:generate` updates the artifact and `npm run openapi:check` fails CI on drift.

The browser API uses the signed `vibe_session` HTTP-only cookie. Mutations enforce same-origin browser requests. Vulnerable creates require an `Idempotency-Key` header. Errors use a stable `{ error: { code, message, correlationId, fields? } }` shape and return the correlation ID in a response header.

This is a same-origin application API, not a Release 1 public-token integration API. Public API tokens and webhooks remain Release 2 scope.
