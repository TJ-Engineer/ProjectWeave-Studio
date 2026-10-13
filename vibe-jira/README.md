# Vibe JIRA

Vibe JIRA is the new implementation described by `IMPLEMENTATION_PLAN.md`. The repository-level `backend/` and `frontend/` applications are disposable prototypes and are not dependencies of this application.

Development status, upcoming stories, release-gate coverage, and risks are tracked in [`DEVELOPMENT_STORYBOARD.md`](./DEVELOPMENT_STORYBOARD.md).

Release 1 includes:

- local email/password authentication with signed, HTTP-only sessions;
- organization and project membership with named capability checks;
- project-member add/change/remove settings for existing organization users;
- organization teams with effective project roles granted through team membership;
- one-time invitations, activation/deactivation, and provider-neutral OIDC with PKCE;
- audited role changes with last-admin and active-assignment safeguards;
- project creation with a default workflow and three-column Kanban board;
- cursor-paginated project and issue collection APIs;
- atomic idempotent project and issue creation using `Idempotency-Key`;
- stable validation, conflict, cursor, authorization, and idempotency errors;
- stable project issue keys;
- issue creation and editing across Epic, Story, Task, Bug, and Subtask types;
- priority, active-project assignee, normalized labels, and parent selection in create/edit/detail flows;
- estimate points, due dates, and constrained sanitized Markdown descriptions with safe preview;
- server-enforced Epic → Story/Task/Bug → Subtask hierarchy rules;
- recoverable member/admin soft deletion with optimistic concurrency and active-child safeguards;
- administrator-only deleted-issue inventory and restoration with stable keys and complete history;
- pointer, touch, keyboard, and workflow-aware explicit-button issue movement and ordering;
- server-owned neighbor-based fractional ranking with exact decimal values and automatic gap rebalance;
- administrator-configured, version-safe per-column WIP limits with non-blocking live warnings;
- project-admin versioned workflow editing for statuses, categories, colors, ordering, directed transitions, and board-column mappings with explicit used-status migration;
- authenticated SSE board invalidation with PostgreSQL commit notifications and reconnect resynchronization;
- none, assignee, and epic swimlanes with shareable URL state and accessible movement controls;
- tenant-scoped server filters and cursor-paged board columns with a 100-card rendering bound;
- authorization-first cross-project PostgreSQL full-text search with multi-value filters, stable sorts, cursors, and shareable URLs;
- private, project, and organization saved filters with stable links plus project-admin board quick filters;
- cursor-paged project backlog and all-issues views backed by the same authorization-first search model;
- chronological plain-text comments, deterministic `@email` mentions, and durable watch/unwatch preferences;
- exactly-once in-app mention/watched-comment delivery with unread state and per-event preferences;
- private S3-compatible issue attachments with signed downloads, strict limits, malware scan states, and soft removal;
- organization-admin correlated audit inspection with scoped filters, opaque cursor paging, and versioned automated retention;
- versioned organization/user/project/board administration with account safeguards, archive/restore, and five-status or simple project templates;
- project-admin CSV dry runs plus idempotent background import/export jobs, explicit invalid-row policy, status, and protected downloads;
- event-derived Kanban reports with published metric definitions and deterministic fixtures;
- structured logs, Prometheus metrics, build identity, generated OpenAPI, CI, load testing, and recovery automation;
- server-validated transitions and reorders with version conflict detection;
- atomic status/rank/version/history/audit/outbox writes;
- an issue activity drawer;
- explicit PostgreSQL migrations, demo seed data, and container health checks.

Issue lifecycle endpoints use optimistic concurrency:

- `DELETE /api/v1/issues/{issueKey}` with `{ "version": number }` soft-deletes active work for members/admins;
- `GET /api/v1/projects/{projectKey}/issues/deleted` lists recoverable work for project administrators;
- `POST /api/v1/issues/{issueKey}/restore` with `{ "version": number }` restores an issue for project administrators.

Board placement is also versioned. `POST /api/v1/issues/{issueKey}/transitions` accepts `transitionId` (or `null` for a same-status reorder), `destinationColumnId`, `destinationStatusId`, `beforeIssueId`, `afterIssueId`, and `version`. Neighbor IDs describe the insertion point; clients never send a rank. The server validates adjacency and workflow state, computes the exact decimal rank in PostgreSQL, and rebalances the destination column when no fractional gap remains. Create, move, delete, and restore placement paths share the same project-scoped ordering lock; new and restored cards append against every status mapped to the destination board column.

Project administrators configure optional column limits from `/projects/{projectKey}/settings/board`. `GET /api/v1/projects/{projectKey}/board` returns the versioned settings model, and `PUT /api/v1/projects/{projectKey}/board/columns/{columnId}` accepts `{ "wipLimit": positiveInteger | null, "version": number }`. Updates are tenant-scoped, optimistic-concurrency protected, audited, and published to the outbox. A breached limit warns every board viewer using the complete column count even while local filters hide cards; it never blocks an otherwise valid move.

The same project settings page manages the active workflow. `GET` and `PUT /api/v1/projects/{projectKey}/workflow` expose a versioned graph of statuses, directed transitions, and board-column mappings. Every configuration is validated before a single transaction updates the graph; removing a status that owns issues requires an explicit migration target, records each issue transition, and preserves audit/outbox evidence. Stale versions, incomplete status-category coverage, duplicate or invalid edges, empty columns, cross-project mappings, and unauthorized changes are rejected without partial writes.

`GET /api/v1/boards/{boardId}/events` is an authenticated SSE stream for board invalidation. PostgreSQL publishes issue and board-column changes only after commit; the application filters them by the authorized project. Clients suppress duplicate or stale per-entity versions, coalesce canonical board refetches, receive 15-second heartbeats, and resynchronize whenever the browser or database listener reconnects. The rationale and recovery model are recorded in [`docs/decisions/0002-sse-board-invalidation.md`](./docs/decisions/0002-sse-board-invalidation.md).

The board's **Swimlanes** control groups the canonical board projection by assignee or root epic; **None** keeps the standard three-column view. The selected non-default mode is stored in `?swimlane=assignee` or `?swimlane=epic`, so reloads and shared links preserve it. Active assignees and the Unassigned/No epic fallback lanes stay visible even when a local text filter has no matching cards. Ranking remains global and server-owned while keyboard, button, pointer, and touch movement continue to work in the grouped projection.

Board search, type, priority, assignee, label, and epic filters execute in PostgreSQL and persist in the URL. Each column initially returns at most 50 cards through an opaque, filter-bound cursor. Accessible **Load next 50** and **Back to first** controls keep at most 100 cards from a column in the DOM while preserving exact global neighbors for moves. Complete unfiltered counts continue to drive WIP warnings. Migration `0008_board_scale_indexes.sql` supplies cursor and common-filter indexes; the PostgreSQL suite traverses a 1,000-issue fixture without gaps or duplicates and enforces a 500 ms p95 board-read budget.

`/search` searches every project the current user can access. Migration `0012_issue_search.sql` adds a weighted `tsvector` and GIN index for summary/description ranking while issue-key matching remains available. Project, type, status, status category, priority, assignee, reporter, label, parent, created-date, and updated-date predicates combine with AND; multiple selections within a predicate use OR. Relevance, board rank, priority, created, updated, and issue-key sorts are stable and cursor-paged. Search URLs preserve the complete query and results deep-link back to the issue drawer.

Searches can be saved as private, project-shared, or organization-shared filters. Stable `/filters/{id}` links resolve the current stored query, and project administrators can expose compatible saved searches as board quick filters. `/projects/{projectKey}/issues` provides backlog and all-issues tabs with cursor paging, persisted URL filters, and issue-drawer deep links.

Issue drawers expose immutable chronological comments. Members and administrators can post sanitized plain text, mention active project users with `@email`, and watch or mute an issue; viewers can read comments and manage their own watch preference. Comment creation is idempotent and transactionally emits history, audit, realtime, mention, and eligible-watcher delivery intents without allowing automatic participation to override an explicit mute.

The notification worker claims mention and watched-comment outbox events with PostgreSQL row locking, inserts each inbox item exactly once, honors the recipient's current event-class preferences, and retries failures with exponential delay before dead-lettering poison events. `/notifications` provides a tenant-scoped, cursor-paged inbox, unread state, mark-all-read, issue links, and preferences. Notification reads also opportunistically drain a bounded batch so delivery remains usable when the dedicated worker is temporarily unavailable.

The general outbox worker claims every non-notification domain topic, records an idempotent delivery ledger entry, and marks the source event published in one transaction. Exponential retries end in a visible dead-letter state. Organization administrators monitor worker freshness, queue age, topic counts, and quarantined events at `/administration/outbox`; retry actions are audited. See the [outbox operations guide](./docs/operations/outbox.md).

Organization administrators inspect mutation evidence at `/administration/audit`, with filters for actor, action, target, correlation ID, and inclusive date range. Results are tenant-scoped and cursor-paged. The versioned retention policy defaults to 365 days; the outbox worker prunes expired rows hourly. See the [audit operations guide](./docs/operations/audit.md).

`/administration/settings` provides organization-name, account-state/role, and project/board lifecycle administration. The server prevents removal of the last active organization administrator and deactivation of a user with active assignments. Project archive/restore hides or restores every normal project surface without deleting data. New projects can use the default five-status delivery workflow or the simple three-status workflow template.

Project administrators validate, import, and export portable CSV from `/projects/{projectKey}/settings/data`. Imports expose atomic-reject or skip-invalid policy before a durable idempotent background job is queued; exports are generated asynchronously and downloaded through a permission-checked endpoint. See the [CSV job operations guide](./docs/operations/data-jobs.md).

Issue attachments are stored outside PostgreSQL in a private S3-compatible bucket. The local stack uses persistent SeaweedFS object storage and ClamAV; downloads use five-minute signed URLs. Uploads are capped at 10 MiB and 20 active files per issue, restricted to PDF, PNG, JPEG, GIF, WebP, plain text, and CSV, and validated against both declared MIME type and file content. Rejected or failed scans never receive a download link. Uploaders and project/organization administrators can soft-remove attachment records while preserving issue history, audit, and outbox evidence.

There is intentionally no permanent-deletion endpoint. Active children block parent deletion, and a deleted child cannot be restored until its parent is active and hierarchy-compatible.

## Run with Docker

```sh
cp .env.example .env
# Replace every placeholder in .env.
docker compose up --build
```

Open `http://localhost:3000` and sign in with `DEMO_ADMIN_EMAIL` and `DEMO_ADMIN_PASSWORD` from `.env`.

The demo seed also creates `DEMO_MEMBER_EMAIL` and `DEMO_VIEWER_EMAIL` users for exercising member and viewer boundaries. Their development-only passwords are configured by `DEMO_MEMBER_PASSWORD` and `DEMO_VIEWER_PASSWORD`.

Migrations and seed data run as one-shot services using the same application image. PostgreSQL data is stored in `postgres-data`, attachment objects in `object-storage-data`, and scanner signatures in `clamav-data`; rebuilding the application image does not remove them.

## Local development

Node.js 20.9 or newer and PostgreSQL are required.

```sh
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

For the hot-reload container profile, run `docker compose -f compose.yaml -f compose.dev.yaml up --build`.

Important commands:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:load
docker compose --profile test run --rm test
infra/operations/recovery-drill.sh
```

Browser journeys cover the complete Release 1 lifecycle, identity and team access, collaboration, administration, reports, responsive interaction, and serious/critical Axe scans. The PostgreSQL suite covers atomicity, concurrency, effective roles, reporting history, jobs, recovery-sensitive data, and tenant isolation. Integration tests refuse to run against a database whose name does not end in `_test`.

## Documentation

- [Deployment](./docs/deployment.md) and [operator runbook](./docs/operations/runbook.md)
- [Administrator guide](./docs/admin-guide.md) and [member guide](./docs/member-guide.md)
- [API reference](./docs/api.md), [metric definitions](./docs/metrics.md), and [performance budgets](./docs/performance.md)
- [Security model](./docs/security.md), [accessibility verification](./docs/accessibility.md), [Release 1 notes](./docs/release-notes-0.1.0.md), [troubleshooting](./docs/troubleshooting.md), and [release checklist](./docs/release-checklist.md)

## Current boundary

This repository contains the Release 1 candidate described by the implementation plan. Production launch still requires the environment-specific and manual evidence in the release checklist.
