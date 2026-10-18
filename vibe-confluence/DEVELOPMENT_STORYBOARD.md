# Vibe Knowledge Development Storyboard

Last updated: 2026-10-18
Plan of record: [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)  
Current release target: Release 1 — Safe, useful knowledge workspace

This is the living delivery record for Vibe Knowledge. The implementation plan
defines product scope and architecture; this storyboard records actual status,
acceptance evidence, release gates, risks, and the next executable work.

## Status rules

| Status        | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `DONE`        | Implemented, tested, documented, and demonstrated against the stated acceptance behavior. |
| `PARTIAL`     | Useful verified behavior exists, but one or more acceptance conditions remain.            |
| `NEXT`        | Refined and ready to become the active vertical slice.                                    |
| `IN PROGRESS` | The one primary product story currently being implemented.                                |
| `PLANNED`     | Ordered but not ready or started.                                                         |
| `BLOCKED`     | Cannot progress without a named decision, dependency, or external change.                 |
| `DEFERRED`    | Deliberately outside the current release boundary.                                        |

No story becomes `DONE` from code completion alone. Relevant schema, domain,
API, UI, authorization, recovery, automated checks, browser evidence, and
documentation must agree.

## Current snapshot

| Item                 | Current state                                                                       |
| -------------------- | ----------------------------------------------------------------------------------- |
| Delivery gate        | `KNW-15` effective-access enforcement is active after `KNW-14` merged               |
| Current milestone    | M1 — Spaces and authoring                                                           |
| Active product story | `SPC-01` — Space membership and restrictive page inheritance                        |
| Active execution     | `KNW-15` in progress on `feat/knw-15-effective-access`; no pull request is open yet |
| Blocking issues      | None                                                                                |
| Story roll-up        | 1 done, 4 partial, 1 in progress, 6 planned                                         |
| Release readiness    | Not ready; no release candidate exists                                              |
| Running path         | `docker compose up --build -d`; local Node/PostgreSQL development remains supported |

## Delivery storyline

```mermaid
flowchart LR
  M0["M0 Publication proof<br/>DONE"] --> M1["M1 Spaces and authoring<br/>IN PROGRESS"]
  M1 --> M2["M2 Collaboration<br/>PLANNED"]
  M2 --> M3["M3 Search and portability<br/>PLANNED"]
  M3 --> M4["M4 Release candidate<br/>PLANNED"]
```

| Milestone                   | Outcome                                                                                                                         | Status        | Exit gate                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| M0 — Publication proof      | A signed-in author creates a space and page, autosaves, publishes immutable revisions, detects conflict, compares, and restores | `DONE`        | Focused unit/integration/browser checks and clean Compose startup pass                |
| M1 — Spaces and authoring   | Teams organize permission-aware page trees and author the frozen Release 1 document schema                                      | `IN PROGRESS` | Hierarchy, editor round-trip, page restrictions, accessibility, and scale checks pass |
| M2 — Collaboration          | Teams discuss, mention, watch, and attach files safely                                                                          | `PLANNED`     | Exactly-once notifications and authorized scan/version/download paths pass            |
| M3 — Search and portability | Permitted knowledge is discoverable, templated, importable, exportable, and recoverable                                         | `PLANNED`     | Leakage, relevance, job, export, backup, and restore gates pass                       |
| M4 — Release candidate      | A secure, accessible, supportable Release 1 can be operated                                                                     | `PLANNED`     | Full quality, migration, browser, security, performance, and human gates pass         |

## Release 1 story board

| ID       | Story/outcome                                                           | Status        | Acceptance evidence or remaining work                                                                            |
| -------- | ----------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `KNW-01` | Draft, publish, compare, and restore first slice                        | `DONE`        | Implementation, PostgreSQL, desktop, responsive, keyboard, and merged clean Compose evidence pass                |
| `FND-01` | Strict TypeScript workspaces, CI gate, and one-image runtime            | `PARTIAL`     | Workspace gate and clean Compose app, worker, migration, seed, health, and object-store startup pass; CI remains |
| `IAM-01` | Development login and provider-neutral production OIDC                  | `PARTIAL`     | Development login uses signed HTTP-only sessions and origin checks; deactivation and OIDC remain                 |
| `SPC-01` | Space membership and restrictive page inheritance                       | `IN PROGRESS` | `KNW-14` is merged; `KNW-15` is active with server-derived effective access; `KNW-16` and `KNW-17` remain        |
| `PGE-01` | Concurrent page tree create, move, reorder, archive, trash, and restore | `PARTIAL`     | Contract confirmed; root/child creation and durable ID routes work; `KNW-18`–`KNW-21` remain                     |
| `EDT-01` | Accessible editor for the frozen Release 1 schema                       | `PARTIAL`     | Contract confirmed; minimal schema/autosave/keyboard behavior works; `KNW-22`–`KNW-25` remain                    |
| `COL-01` | Page and inline comments, mentions, watches, and notifications          | `PLANNED`     | Re-anchor/orphan behavior and deduplicated fan-out pass                                                          |
| `ATT-01` | Private scanned and versioned attachments                               | `PLANNED`     | Authorization, quarantine, preview allowlist, replacement, and retention pass                                    |
| `SRC-01` | Permission-filtered PostgreSQL search and link graph                    | `PLANNED`     | Counts, snippets, suggestions, backlinks, and stale-index cases reveal nothing restricted                        |
| `TPL-01` | Versioned templates and bounded first-party macros                      | `PLANNED`     | Deterministic render, complexity, permission, and migration checks pass                                          |
| `PRT-01` | Markdown import, portable exports, and durable jobs                     | `PLANNED`     | Dry run, idempotency, partial errors, archive manifest, and backpressure pass                                    |
| `PRD-01` | Release hardening and operations                                        | `PLANNED`     | Accessibility, load, migration, recovery, rollback, documentation, and image scans pass                          |

## Confirmed M1 execution

The confirmed M1 story contract is
[`docs/m1-spaces-and-authoring-contract.md`](./docs/m1-spaces-and-authoring-contract.md).
Vibe JIRA epic `KNW-9` contains the documentation issue `KNW-10`, canonical
stories `KNW-11`–`KNW-13`, and their bounded execution issues `KNW-14`–`KNW-25`.

| Order | Canonical story | Vibe JIRA | Outcome                                                           |
| ----- | --------------- | --------- | ----------------------------------------------------------------- |
| 0     | M1 contract     | `KNW-10`  | Record confirmed decisions, source-of-truth changes, and ADRs     |
| 1     | `SPC-01`        | `KNW-11`  | Private membership and non-leaking restrictive page inheritance   |
| 2     | `PGE-01`        | `KNW-12`  | Concurrent, durable, reversible permission-aware page hierarchies |
| 3     | `EDT-01`        | `KNW-13`  | Safe, lossless, accessible authoring for the frozen Release 1 AST |

Only one execution issue, GitHub branch, and pull request is active at a time.
No M1 product story advances from its current `PARTIAL` state until its required
implementation and evidence issues are complete.

## Completed story: KNW-01

User outcome: a development user creates a space and child page, edits a
versioned heading-and-paragraph document, sees autosave state, publishes twice,
compares revisions, and restores revision 1 as revision 3.

Required behavior:

- Local authentication is explicitly development-only and uses a signed,
  HTTP-only session.
- Organization and space capabilities are enforced in server repositories.
- Every untrusted request and structured document is runtime validated.
- Draft autosave detects stale writes; publish detects a stale base revision.
- Publication and restore atomically update the page head, immutable revision,
  audit event, and outbox event.
- Internal IDs and tenant ownership are server-derived and checked.
- The minimal document renderer does not accept arbitrary HTML.
- Refresh preserves the canonical draft and published revision history.

Non-goals:

- Rich editor extensions beyond heading and paragraph
- Realtime collaboration, comments, attachments, macros, import, or export
- Anonymous access, guest links, additive page grants, or Vibe JIRA embeds

## Known risks

| Risk                                                | Current mitigation                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Rich-editor choices distort the foundation          | Prove a versioned minimal document and keep editor integration behind a package boundary               |
| Autosave is confused with publication               | Separate draft and immutable revision tables plus explicit UI states                                   |
| Authorization leaks through future projections      | Keep tenant/capability evaluation in repository boundaries and add adversarial fixtures per projection |
| Sibling applications become coupled through storage | Separate databases and migrations; share only external identity claims and stable URLs                 |
| Release scope outgrows evidence                     | One active product story and milestone exit gates limit work in progress                               |

## Decision log

| Date       | Decision                                                                                                                                                                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-15 | Approved the twelve defaults in plan §20: hosted-ready self-hosting, single-organization Release 1, generic OIDC, explicit publish, bounded editor schema, Markdown-first import, restrictive page inheritance, no guests, safe image/PDF previews, realtime and Jira links in Release 2, and portable container production.            |
| 2026-10-15 | Vibe Knowledge is a separately deployable sibling with its own database and migrations; it may share an OIDC provider but never reads Vibe JIRA's database.                                                                                                                                                                             |
| 2026-10-18 | Confirmed M1 decisions Q1–Q38: deliver `SPC-01` → `PGE-01` → `EDT-01`; use private direct-membership spaces and restrictive inherited page access; preserve private drafts, durable aliases, atomic subtree lifecycle, a library-independent frozen editor schema, and explicit evidence gates. See the M1 contract and ADRs 0002–0004. |

## Evidence log

| Date       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-15 | Created the living storyboard and moved `KNW-01` into progress. No implementation gate is claimed yet.                                                                                                                                                                                                                                                                                                                            |
| 2026-10-16 | Implemented the first executable publication path. Formatting, lint, strict types, four unit tests, the production build, migration `0001`, and two real-PostgreSQL integration tests pass, including unpublished-draft isolation. Compose startup remains required before `KNW-01` can be completed.                                                                                                                             |
| 2026-10-16 | Browser-verified development sign-in, space creation, parent/child page creation, debounced autosave, refresh persistence, two publications, structural/plain-text comparison, and restore of revision 1 as revision 3 at desktop and 390 × 844 responsive widths; keyboard focus moved from Publish to the title field.                                                                                                          |
| 2026-10-16 | Production container verification remains open: two builds reached Docker BuildKit but failed on external registry networking (`ECONNRESET`, then Docker Hub `no route to host`). No container gate is claimed.                                                                                                                                                                                                                   |
| 2026-10-17 | On the isolated `projectweave-knw8-gate` Compose project, a fresh build and startup completed: PostgreSQL and the SeaweedFS S3 API became healthy, migration `0001` and the seed job exited 0, the app and worker stayed running, `/health/live` and `/health/ready` returned 200, the login page and seeded login returned 200, and `npm run check` passed. KNW-01 remains in progress until review and merge.                   |
| 2026-10-17 | Reviewed and merged GitHub pull request [#2](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/2) as `8448d4e`. Review added a signed AWS SigV4 `ListBuckets` check that returned 200 against the configured SeaweedFS S3 endpoint. With the final Compose change on `main`, `KNW-01` and M0 satisfy their recorded exit gates.                                                                                             |
| 2026-10-18 | Created Vibe JIRA M1 epic `KNW-9`, documentation issue `KNW-10`, canonical stories `KNW-11`–`KNW-13`, and bounded execution issues `KNW-14`–`KNW-25`. Opened GitHub PR [#4](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/4) from `docs/knw-10-m1-contract` after `npm run check` passed, and moved only `KNW-10` to Review. No M1 implementation or release gate is claimed.                                           |
| 2026-10-18 | Merged GitHub PR [#4](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/4) as `3849e9b`, moved `KNW-10` to Done and `KNW-11` to Selected, then started `KNW-14` on `feat/knw-14-access-data-model`.                                                                                                                                                                                                                         |
| 2026-10-18 | Added forward-only migration `0002` and a real-PostgreSQL M0-upgrade fixture. `npm run check` passes, including formatting, lint, strict types, four unit tests, and the production build; four PostgreSQL integration tests pass separately. The fixture preserves M0 data and proves slug backfill, active-member checks, restriction pruning, and last-admin protection. No `SPC-01` completion or M1 release gate is claimed. |
| 2026-10-18 | Opened GitHub PR [#5](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/5) from `feat/knw-14-access-data-model` at feature commit `513cfbd`, reconciled the branch and verification evidence in Vibe JIRA, and moved `KNW-14` to Review. `SPC-01` remains in progress and no M1 release gate is claimed.                                                                                                                    |
| 2026-10-18 | Merged GitHub PR [#5](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/5) as `6cb7a1c`, moved `KNW-14` to Done, and started `KNW-15` on `feat/knw-15-effective-access`. The effective-access slice derives policy from persisted identity and membership state, intersects ancestor restrictions, keeps unpublished work principal-private, validates route parameters, and authorizes idempotent retries before replay.   |
| 2026-10-18 | Verified `KNW-15`: `npm run check` passes formatting, lint, strict types, seven non-database tests, and the production build; migration `0003` applies after `0001` and `0002`; five PostgreSQL integration tests pass against `knowledge_test`, including clean/upgrade migration paths and the adversarial effective-access fixture. No `SPC-01` completion or M1 release gate is claimed.                                      |
