# OpenRM product issues

**Last triaged:** 11 November 2026  
**Source:** Initial clean-pilot user feedback  
**Status legend:** Proposed · Ready · In progress · Verified · Closed

This list captures gaps found while using the clean AWS pilot. The existing API already supports project creation, project-scoped keys, and directed decomposition relationships; these issues complete the user-facing workflows and close the mismatch between backend capability and product behavior.

## Triage summary

| ID | Issue | Priority | Status | Dependency |
| --- | --- | --- | --- | --- |
| OPENRM-101 | Add project setup and application-wide multi-project switching | P0 | In progress | None |
| OPENRM-102 | Configure requirement prefixes and allocate identifiers automatically | P0 | In progress | OPENRM-101 |
| OPENRM-103 | Create derived requirements directly from a base requirement | P0 | In progress | OPENRM-102 |
| OPENRM-104 | Add user invitations, project membership, and user profiles | P0 | In progress | OPENRM-101 |

## OPENRM-101 — Add project setup and application-wide multi-project switching

**Problem**

The API exposes `GET/POST /api/v1/projects`, and the Requirements workspace can list and select existing projects. The UI has no project-setup workflow, however, and the selected project is local to that workspace. Traceability, baselines, reviews, verification, and integrations continue to use the deployment-time project ID. Users therefore cannot create and consistently work across multiple projects.

**User story**

As an organization administrator, I want to create projects and select one active project for the whole application so that every workspace operates on the same project without requiring deployment configuration changes.

**Scope**

- Add an administrator-only project setup surface with project name, project key, description, and the prefix defined in OPENRM-102.
- Use the existing idempotent project-creation endpoint and show actionable validation or conflict errors.
- Move active-project state into the application shell and pass it to every project-scoped workspace.
- Provide a persistent project switcher that lists only projects visible to the signed-in user.
- Preserve the last valid selection locally; fall back to the first authorized project when that selection is unavailable.
- Reset project-scoped filters, selections, and cached requests when switching projects so data cannot bleed across project boundaries.
- Provide a useful empty state when an organization has no projects.

**Acceptance criteria**

1. An organization administrator can create at least two projects without using the API directly.
2. The creator becomes an administrator of each new project and the default requirement workspace is available immediately.
3. Switching the active project updates Requirements, Traceability, Baselines, Reviews, Verification, and Integrations consistently.
4. A non-administrator cannot see or invoke project creation.
5. A user sees only projects authorized by organization role or project membership.
6. Project switching never displays artifacts, counts, saved views, or selections from the prior project.
7. Project creation and switching are keyboard accessible and pass automated WCAG 2 A/AA checks.

**Verification**

- API tests for tenant isolation, authorization, conflict handling, and idempotent replay.
- React tests for empty, validation, loading, success, and failure states.
- Browser test that creates two projects, adds distinct requirements, switches through every project-scoped workspace, and proves isolation.

## OPENRM-102 — Configure requirement prefixes and allocate identifiers automatically

**Problem**

Project creation currently accepts a project `key`, while requirement creation requires users to type a complete requirement key manually. There is no explicit requirement-prefix setting or collision-safe numbering. A project such as OpenRM cannot be configured to generate identifiers such as `ORM-001`, `ORM-002`, and so on.

**User story**

As a project administrator, I want to choose a requirement prefix during project setup so that OpenRM assigns consistent, unique identifiers without manual key entry.

**Proposed behavior**

- Add a distinct `requirement_prefix` to project configuration; do not overload the display name or integration key.
- Default the prefix from the project key but allow an administrator to select a value such as `ORM` during setup.
- Validate an uppercase prefix of 2–8 letters or digits, beginning with a letter.
- Require prefix uniqueness within the organization to keep identifiers unambiguous in search and exports.
- Allocate the next sequence number transactionally on the server and format keys as `<PREFIX>-<NUMBER>`, initially zero-padded to three digits.
- Make the prefix immutable after the first requirement is created; a future controlled migration can address renaming safely.
- Preserve explicit identifiers during bounded imports while reserving the sequence so later generated identifiers cannot collide.

**Acceptance criteria**

1. Project setup previews the first identifier, for example `ORM-001`.
2. Normal requirement creation does not ask the user to type a key.
3. Concurrent creates receive different, monotonically allocated keys with no duplicates.
4. Prefix validation and organization-level conflicts produce clear inline errors.
5. Created identifiers remain immutable across requirement revisions.
6. Imports cannot cause the allocator to issue a previously used key.
7. The selected prefix and allocation events are included in audit evidence and deterministic exports.

**Verification**

- Migration and API contract tests for prefix validation, uniqueness, locking, and sequence allocation.
- Concurrent database-path test proving collision-free allocation.
- Browser test creating an `ORM` project and verifying `ORM-001`, `ORM-002`, and `ORM-003` across list, detail, history, search, and export surfaces.

## OPENRM-103 — Create derived requirements directly from a base requirement

**Problem**

The backend supports `DECOMPOSES_TO` relationships and enforces one parent per derived target. The Traceability UI can inspect and resolve relationships but cannot create them, and the Requirements UI has no “create derived requirement” action. Users must create an unrelated requirement and cannot establish its derivation through the product.

**User story**

As an author, I want to create a derived requirement from a selected base requirement so that the new requirement is immediately linked to its parent with controlled trace evidence.

**Scope**

- Add **Create derived requirement** to the selected requirement’s actions.
- Show the base requirement key, title, and revision in the derived-requirement editor.
- Allocate the derived identifier using OPENRM-102 and collect the same controlled fields as normal requirement creation.
- Create the derived requirement and its `DECOMPOSES_TO` relationship atomically and idempotently.
- Bind the relationship to the current source and target revisions and preserve the existing one-parent-per-derived-requirement rule.
- Display parent and child links in the requirement inspector and refresh the trace graph, matrix, coverage, and gap calculations immediately.
- Record attributable audit events for both the new requirement and the decomposition relationship.

**Acceptance criteria**

1. An author or administrator can select a base requirement and create a derived requirement in one workflow.
2. The new requirement receives the configured project prefix and next sequence number.
3. A `DECOMPOSES_TO` link from the base requirement to the derived requirement is committed in the same transaction.
4. If requirement or relationship validation fails, neither object is persisted.
5. The derived requirement shows its parent; the base requirement shows its children.
6. Attempting to assign a second decomposition parent returns a clear conflict without altering evidence.
7. Trace coverage, matrices, exports, revisions, and audit history include the new derivation.
8. The workflow is keyboard accessible and passes automated WCAG 2 A/AA checks.

**Verification**

- Contract and database-path tests for atomic creation, idempotent replay, exact-revision binding, rollback, tenant isolation, and one-parent enforcement.
- React tests for base context, validation, submission, and error recovery.
- Browser test that creates a base requirement, derives two children, verifies parent/child navigation, and confirms the resulting trace graph and export.

**Implementation evidence — 12 November 2026:** The local Requirements inspector now loads current `DECOMPOSES_TO` evidence and exposes explicit, clickable **Parent requirement** and **Child requirements** fields. The focused Chromium regression creates a derived requirement, confirms the root-to-child and child-to-parent links, navigates to a linked requirement outside the filtered result page, and passes automated WCAG A/AA checks.

## OPENRM-104 — Add user invitations, project membership, and user profiles

**Problem**

The clean pilot authenticates through Cognito, but adding a person currently requires direct AWS administration. OpenRM also has no user-directory surface or editable profile details beyond token claims.

**User story**

As an organization administrator, I want to invite users and assign initial organization and project roles, while each user can maintain an OpenRM profile, so that access and ownership can be managed inside the product without exposing credentials.

**Scope**

- Invite users with Cognito `AdminCreateUser`; passwords and temporary-password delivery remain entirely in Cognito.
- Assign one organization role and optional initial project memberships from the Administration workspace.
- Add Cognito groups for administrator, author, reviewer, and viewer roles with least-privilege task permissions.
- Store display name, title, department, and biography in OpenRM's user profile tables.
- Let a signed-in user read and edit only their own profile; let administrators list organization users and memberships.
- Record attributable audit evidence when a user is invited.

**Acceptance criteria**

1. An administrator can invite an email address and assign an organization role plus an initial project role.
2. Production invitations are delivered by Cognito and OpenRM never stores a password.
3. The invited subject appears in the organization directory and selected project membership.
4. A signed-in user can edit display name, title, department, and biography.
5. A non-administrator cannot list or invite organization users.
6. User and membership queries remain organization scoped.
7. The workflow is keyboard accessible and produces actionable errors.

**Verification**

- API tests for validation and administrator policy.
- Clean PostgreSQL path covering invitation persistence, memberships, profile synchronization, and profile update.
- Cognito pilot acceptance covering email delivery, first-password change, group claims, and project isolation.

## Recommended delivery order

1. OPENRM-101 establishes project creation and one shared active-project context.
2. OPENRM-102 adds project-specific identifier policy and server-side allocation.
3. OPENRM-103 builds the derived-requirement workflow on the shared context and allocator.
4. OPENRM-104 adds Cognito-backed invitations, organization/project roles, and editable OpenRM profile data.

The four issues should ship as one pilot-feedback remediation increment. The exit gate is a clean browser journey that creates an `ORM` project, automatically creates `ORM-001`, derives `ORM-002` from it, switches to a second project, invites a user with bounded access, completes that user's profile, and proves project and trace isolation.
