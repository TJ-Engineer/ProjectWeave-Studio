# OpenRM implementation plan

**Planning baseline:** 7 November 2026  
**Current stage:** Phase 6 active; the clean bounded AWS pilot and the [OPENRM-101 through OPENRM-104](ISSUES.md) P0 pilot-feedback remediation increment are deployed in AWS, the first in-product Help increment is protected-CI verified, and the first code-aligned maintainer SDD is published. Live remediation acceptance and Phase 7 controlled development archive work remain planned.

**Primary outcome:** Deliver a self-hostable configuration and requirements management platform with controlled change, end-to-end traceability, review evidence, verification records, and a reconstructable long-term archive of the complete application lifecycle.

## 1. Current state

The repository contains the complete application implementation, historical static-delivery infrastructure, and a clean bounded AWS pilot. The product UI exposes only API-backed workspaces and no longer includes the stakeholder demo, funding sections, fabricated overview data, or sample requirement fallback.

What exists now:

- Responsive React application covering eleven product surfaces, including in-product Help.
- Static production build with Vite.
- Private S3 origin and CloudFront distribution defined in CloudFormation.
- Restricted content-deployment role, deployment scripts, caching, HTTPS, and security headers.
- A connected private ChatGPT Site for stakeholder review.
- Accepted ADRs for service boundaries, revision semantics, relationships, tenancy, baselines, search, and connectors.
- TypeScript web client with lint, typecheck, unit test, build, and generated OpenAPI types.
- Rust API with liveness, readiness, build metadata, structured errors, OIDC validation, and tenant policy checks.
- PostgreSQL migrations, deterministic development seed, Docker Compose, and a one-command bootstrap.
- GitHub Actions workflow for web, Rust, dependency audits, migrations, authenticated database paths, recovery/upgrade rehearsals, and production-artifact validation.
- Protected `main` branch requiring `web`, `api`, `database-path`, `recovery-rehearsal`, and `production-artifact`.
- Completed requirements workspace with isolated projects, scoped roles, folders, tags, typed attributes, saved views, controlled authoring, immutable revisions, comparison, import/export, and audit evidence.
- Directed typed relationships with exact revision evidence, asynchronous suspect propagation, reviewer dispositions, and trace graph, matrix, coverage, and gap queries.
- Attributable changesets, immutable signed baselines, exact baseline comparison, deterministic evidence export, and stale-snapshot protection.
- Baseline-bound review packages with participants, exact-revision comments, append-only resolutions, segregation-of-duty policy, and signed decisions.
- Browser end-to-end coverage for requirements, traceability, baselines, live review, and verification workflows plus automated WCAG 2 A/AA checks.
- Governed Jira delivery with external secret references, idempotent queueing, bounded retry/rate-limit handling, append-only attempts, dead letters, and attributable replay.
- Prometheus SLIs, administrator operations status, structured logs, optional OTLP/HTTP traces, provisioned dashboards/alerts, and a hardened production container topology.
- PostgreSQL backup/restore and forward-only upgrade rehearsals, multi-browser and accessibility coverage, load validation, security smoke tests, and pilot operations documentation.
- A reproducible `OPENRM` dogfood project with 12 system requirements, 48 derived requirements, complete decomposition trace, independent review, and repository-linked signed test, analysis, and observation evidence.
- A one-command portable container distribution for PostgreSQL, forward-only migrations, the hardened API, the complete self-verification project, and the same-origin web application.
- An authoritative structured JSON user manual exposed through persistent dashboard Help, with generated contents, full-text section search, stable anchors, responsive rendering, schema/anchor tests, three-browser WCAG 2 A/AA coverage, and protected container-build evidence.
- A live clean pilot at `https://d3785w5m5qzybi.cloudfront.net/` using Cognito managed login, CloudFront, an origin-restricted ALB, one ARM64 Fargate task, immutable ECR image digests, Secrets Manager, and private deletion-protected PostgreSQL 17 in `us-east-2`.
- A separate blank pilot organization and `OPENRM` project with no demo artifacts, production OIDC enforcement, no fabricated-data fallback, and a verified unauthenticated `401` API boundary.
- Application-wide project setup and switching, project-configured collision-safe requirement identifiers, atomic derived-requirement creation, and Cognito-backed administration and editable user profiles.
- A top-bar development profile switcher backed by the live user directory, with selected-profile roles applied to API requests and production Cognito impersonation explicitly disabled.
- Cognito administrator, author, reviewer, and viewer groups plus least-privilege ECS permissions for in-product invitations, deployed with a healthy API/web task revision and a successful public health/readiness smoke test.

What does not exist yet:

- Complete live acceptance evidence for project creation/switching, automatic-prefix allocation, derived-requirement creation, user invitation delivery, first-password change, profile editing, group claims, and project isolation.
- Environment-specific alert routing plus restore evidence for the encrypted one-day automated-backup window.
- Automated image-registry promotion and a live Jira service identity for the pilot tenant.
- Independent external penetration-test assurance for broader regulated production use.
- Contextual Help links from each primary workspace, representative-role review of the first manual edition, and documentation ownership/freshness controls.
- Independent maintainer walkthrough evidence for the versioned Software Design Description (SDD), plus closure of any discrepancies found against the running system.
- A complete controlled archive: artifact-byte transfer, immutable cross-system manifests, full Jira inbound history, CI evidence ingestion, customer acceptance packages, retention/legal hold/disposition controls, scheduled integrity scans, archive export and restore rehearsal, unified archive search, and joint PostgreSQL/object-store reconstruction evidence.

The repository Phase 5 gate is complete, Phase 6 is active, and Phase 7 is planned. The clean pilot and P0 pilot-feedback remediation increment are deployed; the next product gate is live artifact-creation, invitation, profile, and isolation acceptance.

## 2. Delivery principles

1. **Evidence over appearance.** A workflow is complete only when its behavior, authorization, persistence, audit record, and tests are demonstrable.
2. **Version everything that matters.** Requirements, relationships, reviews, baselines, verification records, and policy changes must retain attributable history.
3. **Contract first.** The OpenAPI contract and domain invariants lead UI and service implementation.
4. **Secure by construction.** Least privilege, immutable audit evidence, tenant isolation, and dependency scanning are release criteria.
5. **Portable core.** PostgreSQL and S3-compatible storage remain the default portable data services; cloud-specific capabilities stay behind adapters.
6. **Thin vertical slices.** Each phase ships an end-to-end user outcome instead of isolated layers.
7. **Local-first promotion.** Routine increments run and regress in the persistent local container stack. Only candidates that pass clean-room reconstruction, the full repository matrix, and multi-browser acceptance are promoted as immutable images to AWS.

## 3. Target architecture

| Layer | Initial decision | Responsibility |
| --- | --- | --- |
| Web client | React + TypeScript | Accessible workflows, optimistic interaction, local validation, API client |
| API | Rust service with versioned REST/OpenAPI | Authorization, commands, queries, validation, idempotency |
| Data | PostgreSQL | Projects, artifacts, relationships, revisions, reviews, permissions |
| Object storage | S3-compatible adapter | Attachments, imports, exports, verification evidence |
| Async work | Transactional outbox + worker | Indexing, imports, exports, connector synchronization |
| Identity | OIDC adapter | Authentication and organization identity mapping |
| Observability | OpenTelemetry-compatible signals | Structured logs, traces, metrics, audit health |
| Connector plane | Adapter SDK; Jira first | Typed inbound/outbound mapping with replay and error queues |

Architecture decisions to ratify in Phase 1:

- Repository structure and service boundaries.
- Revision model: append-only revisions plus materialized current state.
- Relationship and suspect-link propagation semantics.
- Authorization model and tenant boundary.
- Baseline immutability and cryptographic evidence strategy.
- Search approach and indexing consistency.
- Background job and connector replay guarantees.

## 4. Phased implementation

### Phase 0 — Prototype and delivery preview (complete)

**Outcome:** Stakeholders can evaluate the information architecture, product language, and intended workflows.

Exit evidence:

- [x] Core product surfaces represented in the interactive preview.
- [x] Responsive layout and guided product tour.
- [x] Private static hosting path with HTTPS and security headers.
- [x] Restricted content-only AWS deployment role.

### Phase 1 — Foundation (Weeks 1–2)

**Outcome:** A deployable service skeleton proves the architecture, contract, quality gates, and developer workflow.

**Status:** Complete on 8 November 2026. Implementation, local evidence, hosted CI, and protected-branch enforcement all passed the phase exit gate.

Deliverables:

- [x] Ratified ADRs for the seven decisions above.
- [x] Workspace structure for web client, API, migrations, contracts, and documentation.
- [x] TypeScript migration for the web client.
- [x] Rust API with `/health`, `/ready`, build metadata, and structured error envelope.
- [x] PostgreSQL migrations and disposable local development environment.
- [x] OpenAPI v1 contract with generated TypeScript client.
- [x] OIDC authentication spike and authorization policy test harness.
- [x] CI definition for formatting, linting, unit tests, build, dependency audit, and migration validation.
- [x] Local seed data and one-command developer bootstrap.

Exit gate:

- A clean checkout can bootstrap, migrate, test, build, and exercise an authenticated health-to-database path in CI.

Local evidence:

- Clean temporary workspace: `npm ci`, generation, lint, typecheck, three web tests, production build, eight Rust tests, and clippy all passed.
- Database path: two migrations applied to PostgreSQL 17; deterministic organization and project seed verified.
- Runtime path: `/health`, `/ready`, and authenticated `/api/v1/session` returned successfully with database availability.
- Security: npm audit and RustSec audit completed with zero known vulnerabilities after selecting the AWS-LC JWT backend.
- Hosted evidence: the first `Foundation CI` run passed its web, API, security-audit, migration, and authenticated database-path checks on 8 November 2026.
- Delivery control: protected `main` requires the `web`, `api`, and `database-path` checks, enforces the rule for administrators, and disallows force-pushes and deletion.

### Phase 2 — Requirements vertical slice (Weeks 3–6)

**Outcome:** A team can create, revise, organize, search, and inspect requirements with durable history.

**Status:** Complete on 8 November 2026. The live authoring workflow, project controls, persistence, policy boundaries, controlled history, interchange, accessibility, and exit matrix passed protected CI.

Implemented capabilities:

- [x] Tenant-scoped project discovery and requirement list/read operations.
- [x] Materialized current artifacts with immutable revision history.
- [x] Idempotent requirement creation and optimistic revision concurrency.
- [x] PostgreSQL full-text requirement search with offset pagination.
- [x] Transactional create/revise audit evidence.
- [x] OpenAPI contract and generated TypeScript types for the new endpoints.
- [x] Database-path CI coverage for create, replay, revise, history, search, and audit evidence.
- [x] API-backed requirements workspace with create, revise, folder, tag, filter, saved-view, and pagination interactions.
- [x] Project-scoped administrator, author, reviewer, and viewer roles with cross-project isolation.
- [x] Typed custom-attribute validation and project-scoped folders, tags, and saved views.
- [x] Revision comparison plus bounded JSON import and current-state export.
- [x] Chromium end-to-end coverage and automated WCAG 2 A/AA validation.
- [x] Database-enforced append-only audit and revision evidence.

Deliverables:

- [x] Projects, artifact types, artifacts, folders, tags, and custom attributes.
- [x] Requirement creation, editing, validation, revision history, and comparison.
- [x] Optimistic concurrency and idempotent command handling.
- [x] Project roles with read, author, reviewer, and administrator policies.
- [x] Search, filters, saved views, pagination, import, and export.
- [x] Immutable audit events for every controlled mutation.
- [x] Accessibility and end-to-end coverage for the primary authoring path.

Exit gate:

- Two isolated projects can complete the authoring workflow without cross-project data exposure, and all mutations can be reconstructed from audit evidence.

Exit evidence:

- [OpenRM CI run 42492278928](https://github.com/TJ-Engineer/OpenRM/actions/runs/42492278928) passed `web`, `api`, and `database-path` for evidence commit `f498031`.
- PostgreSQL 17 validated two-project isolation, distinct project roles, organization resources, create/replay/revise/conflict, filtered search, history, comparison, import/export, and append-only audit/revision enforcement.
- Chromium validated the primary create/search/revise/compare flow and found no automated WCAG 2 A/AA violations.

### Phase 3 — Traceability and controlled change (Weeks 7–10)

**Outcome:** Users can connect intent to evidence, detect impact, and freeze reproducible baselines.

**Status:** Complete on 8 November 2026. The full contract-led slice covers directed relationship controls, live trace queries, asynchronous suspect impact and reviewer disposition, attributable changesets, immutable signed baselines, comparison, deterministic evidence export, browser workflows, and PostgreSQL exit-gate validation. All protected hosted checks passed.

Deliverables:

- [x] Typed relationships with cardinality and direction rules.
- [x] Trace matrix, graph, coverage queries, and gap reporting.
- [x] Suspect-link propagation and resolution workflow.
- [x] Changesets with attributable diffs and commit messages.
- [x] Immutable baselines and baseline comparison.
- [x] Evidence export with deterministic manifests, hashes, and signatures.

Exit gate:

- A changed upstream requirement flags affected links, records their disposition, and produces a reproducible signed baseline export.

Exit evidence:

- Local PostgreSQL 17 validation passed the complete impact-to-disposition-to-signed-baseline path, including deterministic byte-for-byte evidence replay and append-only enforcement.
- Five Chromium workflows pass for requirements, traceability, changesets, baselines, and automated WCAG 2 A/AA checks.
- [OpenRM CI run 42499758656](https://github.com/TJ-Engineer/OpenRM/actions/runs/42499758656) passed `web`, `api`, and `database-path` for the final Phase 3 branch state.

### Phase 4 — Reviews and verification (Weeks 11–14)

**Outcome:** Gate decisions can be made from attributable review and verification evidence.

**Status:** Complete on 8 November 2026. The complete review-to-verification path passed local gates and protected hosted CI.

Deliverables:

- [x] Review packages, participants, comments, resolutions, and approvals.
- [x] Approval-policy enforcement and segregation-of-duty checks.
- [x] Verification cases, procedures, runs, results, and attachments.
- [x] Coverage rollups from requirement to verification result.
- [x] Gate-readiness calculation with explainable contributors.
- [x] Notifications and due-date events.

Exit gate:

- A review package can be assembled from a baseline, approved under policy, verified, and exported with complete evidence.

Completion evidence:

- A clean PostgreSQL 17 database passed package creation, idempotent replay, exact baseline-revision comment binding, blocker-held approval, resolution-triggered completion, tenant isolation, and signed-decision verification.
- Direct updates to lifecycle events, participants, comments, resolutions, and decisions were rejected by append-only database triggers.
- Chromium passes the complete live Review Room workflow and automated WCAG 2 A/AA checks.
- A second clean PostgreSQL 17 database passed the complete requirements-to-trace-to-baseline-to-review-to-verification journey, including independent execution ownership, signed results, content-addressed attachment manifests, 100% exact-revision coverage, an explainable ready gate, due/overdue/completion events, tenant isolation, and idempotent replay.
- Repeated complete gate exports were byte-for-byte identical and returned a valid HMAC-SHA256 signature over review decisions, verification cases, runs, results, attachments, coverage, readiness, and due events.
- Direct changes to cases, targets, run events, results, attachment manifests, and due events were rejected by PostgreSQL append-only triggers.
- Chromium passes planning, execution, result capture, coverage/readiness, signed export, and automated WCAG 2 A/AA verification workflows.
- [OpenRM CI run 42504423145](https://github.com/TJ-Engineer/OpenRM/actions/runs/42504423145) passed `web`, `api`, and `database-path` for the complete Phase 4 branch state.

### Phase 5 — Integration and beta hardening (Weeks 15–17)

**Outcome:** A pilot team can operate OpenRM reliably, recoverably, and with measured service health.

**Status:** Complete on 8 November 2026. Local code, browser, PostgreSQL 17 runtime, load, recovery, upgrade, security, and deployment-artifact gates pass, and all five protected hosted jobs passed in [OpenRM CI run 42508760769](https://github.com/TJ-Engineer/OpenRM/actions/runs/42508760769).

Deliverables:

- [x] Jira connector with mapping, replay, rate-limit handling, and dead-letter workflow.
- [x] OpenTelemetry traces, service-level indicators, dashboards, and alerts.
- [x] Backup, restore, disaster-recovery, and upgrade rehearsals.
- [x] Threat model, security review, dependency policy, and automated penetration-test smoke remediation for the bounded pilot.
- [x] Load, soak harness, browser-compatibility, and accessibility validation.
- [x] Administration guide, operator runbook, and pilot onboarding.

Exit gate:

- The pilot meets the agreed reliability, security, recovery, and usability thresholds with no unresolved launch-blocking risks.

Completion evidence:

- `web`, `api`, `database-path`, `recovery-rehearsal`, and `production-artifact` passed in [OpenRM CI run 42508760769](https://github.com/TJ-Engineer/OpenRM/actions/runs/42508760769).
- Protected `main` now requires all five Phase 5 checks with strict up-to-date validation and administrator enforcement.
- The clean AWS pilot is commissioned in `us-east-2` and its initial administrator invitation is issued; first sign-in and live artifact-creation acceptance remain environment-specific operational gates.
- The `OPENRM` self-verification project reaches 100% trace coverage and 100% passed exact-revision verification coverage with no orphans, suspect links, or readiness blockers; [OpenRM CI run 42512977538](https://github.com/TJ-Engineer/OpenRM/actions/runs/42512977538) reconstructed the complete gate from a clean database in the protected `database-path` workflow.
- [OpenRM CI run 42518730569](https://github.com/TJ-Engineer/OpenRM/actions/runs/42518730569) built the complete portable container distribution and reconstructed its PostgreSQL, migrations, API, 60-requirement bootstrap, and same-origin web gateway from a clean volume with non-root, read-only, capability-dropped application containers.

### Phase 6 — Product documentation and maintainability (Weeks 18–19, active)

**Outcome:** End users can obtain complete, task-oriented help from inside OpenRM, and maintainers have a code-aligned design reference for safely evolving and operating the application.

**Status:** Active. The structured JSON first-edition manual, persistent Help route, generated contents, search, stable anchors, responsive rendering, schema/browser/WCAG checks, and production artifact pass in [OpenRM CI run 42547019573](https://github.com/TJ-Engineer/OpenRM/actions/runs/42547019573). The first code-aligned maintainer SDD is published and locally source/link verified. Pilot review, contextual workspace links, external-link validation, ownership controls, and the independent SDD walkthrough remain open.

Deliverables:

- [x] Publish `docs/user/USER_MANUAL.json` as the authoritative user manual, with a versioned schema, generated linked table of contents, document version, applicable OpenRM release, owner, and last-verified date.
- [x] Add a persistent **Help** entry to the OpenRM dashboard that opens a responsive, keyboard-accessible manual route without losing the user's application context.
- [x] Cover getting started, authentication, dashboard navigation, projects and roles, requirement authoring, folders/tags/attributes/saved views, revision comparison, traceability, suspect links, changesets, baselines, reviews, verification, search, import/export, Jira operations, notifications, accessibility/keyboard use, troubleshooting, FAQ, glossary, and support escalation.
- [x] Provide stable section anchors and an in-product linked table of contents.
- [ ] Add contextual deep links from relevant OpenRM workspaces into the corresponding manual procedures.
- [x] Publish `docs/design/SOFTWARE_DESIGN_DESCRIPTION.md` as the authoritative, versioned SDD for application maintenance.
- [x] Document system context, architecture views, repository and component boundaries, runtime interactions, APIs, data/revision/audit design, identity/authorization/tenancy, asynchronous processing, configuration and secrets, deployment topologies, security controls, observability, failure handling, backup/recovery/upgrades, CI/test strategy, and known limitations.
- [x] Link the SDD to the accepted ADRs and concrete source, contract, migration, infrastructure, and operations paths; include maintainable Mermaid diagrams stored as text in the document.
- [ ] Define ownership and change triggers so user-visible workflow changes update the manual and design/runtime changes update the SDD in the same pull request.
- [x] Add local automated checks for duplicate or missing anchors, table-of-contents coverage, dashboard Help routing, search/navigation, responsive rendering, and WCAG 2 A/AA regressions.
- [x] Protect the documentation structure, Help browser/WCAG, and production-artifact checks in hosted CI.
- [ ] Validate external documentation links as part of the release gate.

Exit gate:

- A representative author, reviewer, verifier, and administrator can open Help from the dashboard, navigate the table of contents, deep-link to a task, and complete their primary workflows without undocumented steps.
- A maintainer unfamiliar with the implementation can use the SDD to locate the responsible component, interface, data objects, security boundary, tests, deployment path, and operational evidence for a representative change.
- Manual and SDD reviewers confirm that every link resolves, diagrams match the deployed architecture, documented roles and workflows match product behavior, and document version metadata identifies the verified release.

### Phase 7 — Controlled development archive (Weeks 20–23, planned)

**Outcome:** OpenRM can preserve, discover, verify, export, restore, and reconstruct the complete application-lifecycle record for a project or release, including requirements, Jira history, source and build identity, test evidence, release artifacts, and customer acceptance.

**Status:** Started. OpenRM now provides project-scoped S3-compatible inventory plus guarded, audited administrator deletion for unlinked objects, alongside append-only PostgreSQL evidence, deterministic signed exports, content-addressed attachment metadata, and database recovery rehearsals. It does not yet ingest and retain every external evidence byte, collect complete Jira inbound history, manage customer acceptance packages, enforce archive retention and legal holds, or prove coordinated database/object-store reconstruction.

Deliverables:

- [x] Add project-scoped object inventory and administrator deletion that rejects verification-linked objects, coordinates linking/deletion races, and records attributable audit evidence.
- [ ] Add S3-compatible upload, download, multipart, and presigned-transfer support for evidence bytes while keeping cloud-specific behavior behind the object-storage adapter.
- [ ] Create immutable artifact manifests that bind hashes, signatures, media types, sizes, source identities, timestamps, and object versions to projects, requirements, baselines, commits, builds, and releases.
- [ ] Collect and reconcile complete Jira inbound history, including issue revisions, comments, transitions, attachments, links, users, and synchronization checkpoints, without weakening the existing governed outbound delivery path.
- [ ] Add authenticated CI evidence-ingestion endpoints and reference pipeline integrations for test results, coverage, static analysis, security scans, build provenance, software bills of materials, and release artifacts.
- [ ] Add dedicated customer-acceptance packages with acceptance criteria, delivered baseline/release identity, customer observations, decisions, signatures, attachments, and revocation or supersession history.
- [ ] Define and enforce retention schedules, legal holds, retention overrides, disposition review, dual approval, and auditable defensible deletion across PostgreSQL records and object versions.
- [ ] Run scheduled integrity scans that recompute object hashes, validate signatures and manifest references, detect missing or altered evidence, and emit attributable findings and alerts.
- [ ] Export a self-describing archive and rehearse its restore in an isolated environment without relying on the source OpenRM deployment.
- [ ] Search and retrieve archived evidence by project, requirement, Jira key, commit, build, test, baseline, release, customer, and acceptance decision while preserving tenant and role boundaries.
- [ ] Prove that PostgreSQL records and referenced object versions can be backed up, restored, and reconstructed together to the same consistent archive point.

Exit gate:

- A selected release can be exported and restored into an isolated environment; every manifest hash and signature verifies, and the restored record traces requirements through Jira, commits, builds, tests, release artifacts, and customer acceptance.
- A coordinated recovery rehearsal reconstructs PostgreSQL records and exact object versions to a declared archive point with no missing, substituted, or unreferenced required evidence.
- Automated policy tests prove retention, legal hold, disposition approval, tenant isolation, and audit behavior, including denied deletion while a hold is active.
- Scheduled integrity scanning and unified archive search pass on representative evidence volumes, and operators can resolve or formally disposition every reported integrity finding.

## 5. Phase 1 execution backlog

| ID | Priority | Work item | Primary evidence | Estimate |
| --- | --- | --- | --- | --- |
| FND-001 | P0 | Ratify domain boundaries and ADR set | Approved ADRs | 3 days |
| FND-002 | P0 | Establish workspace and local bootstrap | Clean-checkout run | 2 days |
| API-001 | P0 | Publish OpenAPI skeleton and error model | Contract test | 2 days |
| API-002 | P0 | Create Rust health/readiness service | Integration test | 3 days |
| DAT-001 | P0 | Add PostgreSQL migration workflow | Migration round trip | 2 days |
| SEC-001 | P0 | Prove OIDC identity and authorization policy | Policy tests | 3 days |
| WEB-001 | P1 | Migrate the client to TypeScript and API client | Typecheck + build | 3 days |
| QLT-001 | P0 | Add CI quality and security gates | Protected CI run | 2 days |

FND-001, FND-002, API-001, API-002, DAT-001, SEC-001, WEB-001, QLT-001, and QLT-002 are complete. Phase 1 through Phase 5 are closed; Phase 6 is active; Phase 7 is planned.

## 5.1 Phase 2 execution backlog

| ID | Priority | Work item | Status | Primary evidence |
| --- | --- | --- | --- | --- |
| REQ-000 | P1 | Decompose the requirements vertical slice | Complete | Contract-led increment defined |
| REQ-101 | P0 | Persist requirements and immutable revisions | Complete | Migration and database-path test |
| REQ-102 | P0 | Create, list, read, revise, search, and inspect history | Complete | API contract and runtime checks |
| REQ-103 | P0 | Enforce concurrency, idempotency, tenancy, and audit | Complete | PostgreSQL isolation and immutability matrix |
| REQ-104 | P0 | Connect the authoring UI to the API | Complete | Chromium authoring workflow |
| REQ-105 | P1 | Add folders, tags, typed attributes, and saved views | Complete | API runtime and UI acceptance evidence |
| REQ-106 | P1 | Add import/export, comparison, accessibility, and E2E | Complete | Protected CI evidence suite |

## 5.2 Phase 3 execution backlog

| ID | Priority | Work item | Status | Primary evidence |
| --- | --- | --- | --- | --- |
| TRC-101 | P0 | Persist directed typed relationships with cardinality and exact revision evidence | Complete | Isolated PostgreSQL API and immutability matrix |
| TRC-102 | P0 | Propagate and resolve suspect links with attributable dispositions | Complete | Upstream revision impact workflow |
| TRC-103 | P1 | Add trace graph, matrix, coverage, and gap queries | Complete | API queries and Chromium acceptance path |
| CHG-101 | P0 | Add changesets with attributable diffs and commit messages | Complete | Parent-relative controlled commit workflow |
| BAS-101 | P0 | Add immutable baselines and baseline comparison | Complete | Reviewer-only reproducible manifest comparison |
| EVD-101 | P0 | Export deterministic hashed and signed evidence | Complete | Repeated byte-for-byte manifest verification |

## 5.3 Phase 4 execution backlog

| ID | Priority | Work item | Status | Primary evidence |
| --- | --- | --- | --- | --- |
| REV-101 | P0 | Persist baseline-bound packages, participants, comments, resolutions, and decisions | Complete | Migration plus clean PostgreSQL workflow |
| REV-102 | P0 | Enforce approval threshold, segregation of duties, replay, tenancy, and audit | Complete | Policy denial and signed-decision runtime matrix |
| REV-103 | P0 | Connect the Review Room to live review evidence | Complete | Chromium workflow and WCAG A/AA scan |
| REV-104 | P0 | Protect the complete Phase 4 matrix in hosted CI | Complete | `web`, `api`, and `database-path` passed in run `42504423145` |
| VER-101 | P0 | Persist verification cases, procedures, runs, results, and attachments | Complete | Migration, API, clean PostgreSQL workflow, and immutable evidence matrix |
| VER-102 | P0 | Roll verification evidence into requirement coverage and gate readiness | Complete | Exact-revision coverage, explainable readiness, and browser evidence |
| NTF-101 | P1 | Emit review and verification due-date notifications | Complete | Idempotent due-soon, overdue, and completion events |

## 5.4 Phase 5 execution backlog

| ID | Priority | Work item | Status | Primary evidence |
| --- | --- | --- | --- | --- |
| INT-101 | P0 | Deliver governed Jira mapping, queueing, retry, dead-letter, and replay | Complete | API/UI workflow, append-only attempts, and database-path matrix |
| INT-102 | P0 | Record immutable signed agent-run provenance linked to exact OpenRM revisions and external factory outputs | Complete locally | Migration `0014`, REST contract, policy/idempotency/audit controls, signature verification, unit tests, and database-path coverage |
| OPS-101 | P0 | Add metrics, OTLP traces, SLO status, dashboards, and alerts | Complete | Prometheus endpoint, operations API, and provisioned observability topology |
| OPS-102 | P0 | Rehearse backup, restore, disaster recovery, and upgrades | Complete | PostgreSQL 17 archive round trip and idempotent migration rehearsal |
| SEC-201 | P0 | Complete threat review and pilot security remediation | Complete | Threat model, dependency gates, security smoke matrix, and hardened container |
| QLT-201 | P0 | Validate load, soak harness, browsers, and accessibility | Complete | Load threshold plus Chromium, Firefox, WebKit, and WCAG A/AA matrix |
| PIL-101 | P1 | Publish administration, operations, and onboarding procedures | Complete | Deployment guide, administration guide, runbook, and pilot checklist |

## 5.5 Phase 6 execution backlog

| ID | Priority | Work item | Status | Primary evidence |
| --- | --- | --- | --- | --- |
| DOC-201 | P0 | Define the manual information architecture, audience map, document metadata, ownership, and linked table of contents | Complete | `docs/user/USER_MANUAL.json` metadata and schema-validated contents cover every primary user role and product workflow |
| DOC-202 | P0 | Author the comprehensive OpenRM user manual, including procedures, troubleshooting, FAQ, glossary, and accessible visual guidance | In progress | First edition is complete; representative-role review and visual guidance remain |
| DOC-203 | P1 | Add a maintainer-friendly, schema-aware JSON Help editor and preview workflow | Planned — later | A maintainer can edit, validate, preview, and review manual changes without modifying renderer code |
| WEB-201 | P0 | Add persistent dashboard Help navigation, responsive rendering, stable anchors, and contextual deep links | In progress | Persistent navigation, rendering, search, and anchors pass browser tests; contextual links remain |
| ARC-201 | P0 | Generate the code-aligned Software Design Description for application maintenance | Complete | `docs/design/SOFTWARE_DESIGN_DESCRIPTION.md` covers the implementation and validates 69 unique local source/document links plus ADR traceability |
| ARC-202 | P1 | Validate SDD architecture, security, data, deployment, recovery, and maintenance guidance against the running system | In progress | Source and link reconciliation complete; independent maintainer walkthrough and documented discrepancy closure remain |
| QLT-301 | P0 | Enforce documentation links, anchors, table-of-contents coverage, Help routing, keyboard access, and WCAG checks in CI | In progress | The JSON-backed complete matrix and production artifact pass in OpenRM CI run `42547019573`; external-link validation remains |
| GOV-201 | P1 | Add pull-request and release criteria that keep the manual and SDD synchronized with relevant changes | Planned | Contribution checklist, document owners, release review, and freshness evidence |

## 5.6 Phase 7 execution backlog

| ID | Priority | Work item | Status | Primary evidence |
| --- | --- | --- | --- | --- |
| ARV-100 | P0 | Inventory project objects and safely delete unlinked objects | Complete | Project/tenant prefix isolation, administrator authorization, linked-object conflict, audit evidence, versioned storage, and focused browser/API checks |
| ARV-101 | P0 | Add S3-compatible evidence upload, download, multipart, and presigned transfers | Planned | Object-adapter contract, authorization tests, checksum validation, and portable integration test |
| ARV-102 | P0 | Persist immutable cross-system artifact manifests linked to projects, requirements, baselines, commits, builds, and releases | Planned | Manifest schema, database immutability tests, deterministic signature verification, and object-version binding |
| ARV-103 | P0 | Collect and reconcile complete Jira inbound history | Planned | Connector replay, checkpoint recovery, attachment capture, change-history reconciliation, and tenant-isolation tests |
| ARV-104 | P0 | Ingest CI test, analysis, security, provenance, SBOM, build, and release evidence | Planned | Authenticated ingestion contract plus reference pipeline end-to-end tests |
| ARV-105 | P0 | Create controlled customer-acceptance packages and external signature evidence | Planned | Acceptance workflow, signature validation, supersession history, authorization, and signed export test |
| ARV-106 | P0 | Enforce retention schedules, legal holds, and approved defensible disposition | Planned | Policy matrix, hold-denial tests, dual-approval deletion, object-version disposition, and immutable audit evidence |
| ARV-107 | P1 | Schedule archive integrity scans that recompute hashes and validate signatures and references | Planned | Corruption and missing-object injection tests, scan findings, alerts, and attributable resolution evidence |
| ARV-108 | P0 | Export and restore a self-describing archive in an isolated environment | Planned | Clean-environment archive portability and restore rehearsal |
| ARV-109 | P1 | Search archive evidence across requirements, Jira, source, builds, tests, releases, and acceptance | Planned | Relevance, authorization, tenancy, pagination, and representative-volume tests |
| ARV-110 | P0 | Reconstruct PostgreSQL records and exact object versions to one consistent archive point | Planned | Coordinated backup/restore rehearsal with referential, hash, signature, and completeness verification |

## 6. Quality gates

Every merged vertical slice must satisfy:

- Code review and linked acceptance criteria.
- Unit tests for domain invariants and policy decisions.
- Integration tests for persistence and API contracts.
- End-to-end coverage for the changed critical workflow.
- No unresolved critical or high dependency vulnerabilities.
- Keyboard operation, focus visibility, semantic structure, and automated accessibility checks.
- Migration forward test and documented rollback or roll-forward strategy.
- Structured audit event for controlled mutations.
- Updated operational notes and architecture decisions where behavior changed.
- Updated user-manual procedures when a user-visible workflow, role, message, or navigation path changes.
- Updated SDD sections and diagrams when architecture, interfaces, data, security boundaries, deployment, operations, or maintenance behavior changes.
- Passing documentation link, anchor, table-of-contents, dashboard Help route, keyboard, and accessibility checks when documentation surfaces are affected.
- Immutable manifest, hash, signature, object-version, and referential-integrity verification when archive evidence is created, transferred, exported, or restored.
- Retention, legal-hold, disposition-approval, tenant-isolation, and immutable-audit policy tests when archive lifecycle behavior changes.
- A coordinated PostgreSQL and object-store recovery test when archive schemas, object layouts, backup procedures, or restore procedures change.

## 7. Program risks

| Risk | Effect | Mitigation | Trigger to escalate |
| --- | --- | --- | --- |
| Prototype scope is mistaken for implemented capability | Unrealistic schedule and readiness claims | Keep prototype and production metrics separate; demonstrate evidence at every gate | A milestone is reported complete without API, persistence, policy, and tests |
| Revision and baseline semantics are designed late | Expensive data-model rework | Resolve revision, relationship, and baseline ADRs in Phase 1 | Two features implement incompatible history models |
| Authorization is bolted on after feature work | Cross-project exposure or inconsistent policy | Central policy layer, deny-by-default tests, tenant-isolation suite | A query bypasses the policy boundary |
| Connector work destabilizes the core | Delivery stalls on external-system behavior | Adapter boundary, outbox, replay, rate limiting, dead-letter queue | External availability blocks a core transaction |
| Static preview infrastructure is treated as production architecture | Missing API, data, recovery, and observability controls | Separate preview hosting from platform environments and operating model | Production data is proposed for the preview stack |
| External evidence is linked but not durably captured | A release record becomes incomplete when Jira, CI, source, or customer systems change or are retired | Ingest evidence bytes and complete history into immutable manifests with retention, integrity scanning, and portable export | A required audit artifact can only be retrieved from an external system |
| Database and object archives recover to different points | Restored records reference missing or incorrect evidence bytes | Coordinate archive points, retain exact object versions, and rehearse joint reconstruction | A restore contains missing objects, hash mismatches, or manifest references newer than the database snapshot |

## 8. Development dashboard operating rules

The in-app Development page is the visual companion to this plan. Until live delivery integrations exist, it is a versioned planning baseline rather than a real-time project-management system.

Update the dashboard and this plan together when:

- A phase gate changes state.
- Scope, sequencing, architecture, or a release criterion changes.
- A new P0/P1 risk is accepted or resolved.
- The sprint commitment changes materially.

Once Phase 1 is complete, replace static dashboard constants with a small delivery-status endpoint populated from CI, the issue tracker, deployment metadata, and the risk register. Preserve source timestamps and make stale data visible.

## 9. Definition of beta-ready

OpenRM is beta-ready when a pilot team can:

1. Authenticate and operate within an isolated project.
2. Create and revise controlled requirements with full history.
3. Trace needs through requirements to verification evidence.
4. Resolve suspect links and compare immutable baselines.
5. Conduct a policy-compliant review and approval.
6. Export a deterministic evidence package.
7. Recover the service and data within agreed objectives.
8. Operate the system with documented alerts, runbooks, and no unresolved launch-blocking security findings.
9. Open comprehensive in-product Help and complete role-specific workflows using the versioned user manual.
10. Maintain and extend the application using a verified SDD that traces architecture and operational guidance to the implementation.

