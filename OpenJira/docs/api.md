# API reference

[`openapi.json`](./openapi.json) is the generated OpenAPI 3.1 contract for `/api/v1`. Paths and methods are discovered from route handlers; JSON request bodies reference JSON Schema generated from the Zod definitions in `@vibe/contracts`; file upload uses multipart form data. `npm run openapi:generate` updates the artifact and `npm run openapi:check` fails CI on drift.

The browser API uses the signed `vibe_session` HTTP-only cookie. Software-factory agents use an expiring `Authorization: Bearer vibe_agent_...` credential created by an operator. Agent tokens resolve to an active Vibe JIRA user and therefore receive exactly that user's organization, project, and capability permissions; they do not bypass server authorization.

Mutations enforce same-origin browser requests while header-only non-browser clients are admitted without an `Origin` header. Vulnerable creates require an `Idempotency-Key` header. Errors use a stable `{ error: { code, message, correlationId, fields? } }` shape and return the correlation ID in a response header. See the [software-factory agent guide](./agent-rest-api.md) for token lifecycle and dual-service examples.

Agent tokens are an operator-managed, first-party machine interface. General end-user public API token management and webhooks remain Release 2 scope.

## Story completion actions

Story create requests may include `completionActions`, an ordered array of up to 50 non-empty summaries of at most 200 characters. The field must be empty for every issue type except `STORY`. Each entry atomically creates a normal same-project Task and a durable one-to-one Completion Action (COA) link; idempotent issue-create replay does not duplicate either record.

- `GET /api/v1/issues/{issueKey}/completion-actions` returns the active ordered checklist and linked Task status/version data.
- `POST /api/v1/issues/{issueKey}/completion-actions` accepts `{ "summary": string, "storyVersion": number }` and requires an `Idempotency-Key` header plus issue create/edit capabilities.
- `PATCH /api/v1/issues/{issueKey}/completion-actions/{completionActionId}` accepts `summary` and/or `position`, or a separate `completed` change, together with `version` and `storyVersion`. Summary/reorder changes require issue edit; checkbox changes require issue transition.
- `DELETE /api/v1/issues/{issueKey}/completion-actions/{completionActionId}` accepts `{ "version": number, "storyVersion": number }` and requires issue edit/delete. It soft-deletes the generated Task while preserving history.

Task Done-category status is authoritative for the checkbox. A checkbox mutation uses exactly one eligible configured Task transition; `COA_TRANSITION_UNAVAILABLE` directs the caller to advance the Task through its workflow when no unambiguous direct transition exists. `STORY_COAS_INCOMPLETE` rejects any ordinary or administrative path that would put a Story in a Done-category status with an open COA. `COA_TASK_REOPEN_REQUIRES_STORY` prevents a generated Task from leaving Done while its Story remains Done. Generated Tasks cannot be independently type-changed, reparented, deleted, or restored.
