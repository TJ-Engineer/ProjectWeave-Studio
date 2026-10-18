# M1 spaces and authoring contract

Status: Confirmed on 2026-10-18

Vibe JIRA epic: `KNW-9`

Documentation issue: `KNW-10`

This contract records the confirmed behavior and evidence boundary for M1. The
implementation plan remains the product plan, the storyboard remains the
delivery record, and Vibe JIRA owns execution state. If an implementation
choice conflicts with this contract, resolve the conflict in documentation
before broadening the story.

## Outcome and order

M1 delivers permission-aware team-space page trees and authoring for the frozen
Release 1 document schema. Work proceeds in this order:

1. `SPC-01` — private team-space membership and restrictive page inheritance
2. `PGE-01` — concurrent page hierarchy and lifecycle
3. `EDT-01` — accessible frozen-schema authoring

Only one execution issue, GitHub branch, and pull request is active at a time.
The active issue is merged and its evidence reconciled before the next issue
starts.

## Space and permission contract

### Space boundary

- M1 supports private team spaces with direct user membership.
- Personal spaces and reusable groups remain Release 1 follow-up work.
- Guests, external invitations, bulk membership import, and implicit
  organization-wide access are outside M1.
- A new space grants its creator `ADMIN`; other active organization members
  gain access only through explicit membership.
- The M1 roles are `ADMIN`, `EDITOR`, and `VIEWER`. The later `COMMENTER` role
  is not introduced before the comment story.
- Organization and space administrators manage membership and page policy.
- A space must retain at least one administrator. An administrator may remove
  or demote themself only when another space administrator remains.
- Space keys are immutable. Name and description changes require the expected
  space version.
- Only an organization administrator may archive or restore a space. An
  archived space is absent from normal lists and frozen for mutation, while
  authorized published pages remain readable. M1 has no permanent space
  deletion.

### Restrictive page access

- A page restriction is a direct-user allowlist containing active space
  members. It never changes a member's space role or grants a capability the
  member did not already possess.
- Restrictions apply to the page subtree. A descendant restriction intersects
  with every ancestor restriction; a child cannot reopen access.
- Organization and space administrators may manage restrictions and access
  every published page in the space. They cannot read another principal's
  unpublished page or private draft.
- An unpublished page and its draft-only descendants are visible only to their
  creator. A descendant cannot be published before every ancestor is
  published.
- Authorization filtering occurs before pagination, counts, breadcrumbs, tree
  results, or other discovery projections. Hidden and nonexistent content use
  the same response and reveal no title, count, rank, or path.
- Published pages open in read mode. Editing is an explicit action that
  requires `page:edit`; a viewer never receives a draft payload.

### Membership changes and offboarding

- A normal member removal or editor-to-viewer demotion is blocked while that
  principal owns unpublished pages. The principal must publish or trash that
  work first; M1 does not transfer a private draft.
- Drafts attached to already-published pages are retained after removal or
  demotion and become accessible again only when edit access is explicitly
  restored.
- Removal atomically prunes the principal from page allowlists. Re-adding the
  principal does not revive historical page grants.
- Revocation takes effect immediately. Subsequent content reads and mutations
  return the non-disclosing response, and the client clears local recovery
  state after learning access was revoked.
- Organization-level deactivation overrides ordinary removal blockers and
  immediately denies all access. Private unpublished work is sealed rather
  than transferred or exposed. Reactivation does not silently restore space
  memberships or page grants.
- Administration surfaces may report affected counts but never reveal private
  titles or document bodies.

## Page hierarchy and lifecycle contract

### Identity, scale, and navigation

- A page UUID is the canonical durable address. A readable space-and-slug URL
  redirects to it.
- Renaming a title regenerates its readable slug. Every historical slug remains
  permanently reserved as an alias for the same page, including while the page
  is archived or trashed. Collisions receive a deterministic suffix.
- A space may contain at least 10,000 pages and a parent may contain at least
  1,000 direct children. A tree response returns at most 100 nodes and children
  load incrementally.
- Tree navigation supports pointer, touch, and keyboard input at desktop and
  320 CSS pixels. Movement always has a non-drag alternative.

### Move and ordering

- Only organization or space administrators move or reorder pages in M1.
- A subtree move validates tenant, space, source, destination, cycle, and
  lifecycle invariants before changing state.
- Moving to a less restrictive parent must not broaden access. The previous
  effective allowlist is materialized on the moved root when necessary.
  Moving beneath a stricter ancestor may narrow access.
- Each sibling list has a version. A move locks the affected parent lists,
  checks the expected versions, and commits placement, audit, and outbox
  evidence atomically.
- Fractional-rank exhaustion deterministically rebalances only the affected
  sibling list. A stale request receives a stable conflict instead of silently
  overwriting another administrator's change.

### Page lifecycle

- Archive is available only for published subtrees. Archived content moves out
  of active navigation but remains readable, read-only, and permission-checked
  at its canonical address.
- Trash removes content from normal routes and discovery surfaces. M1 retains
  trashed content indefinitely and provides no permanent-delete operation.
- Organization and space administrators may archive, trash, or restore
  published subtrees.
- An editor may trash or restore their own never-published subtree only when
  every page in it belongs to that principal. An operation that encounters
  another principal's unpublished work is rejected with a count but no content
  metadata.
- Archive, trash, and restore are atomic subtree transitions and retain private
  drafts and immutable revision history.
- Restore uses the original parent and relative position when still valid.
  Otherwise an administrator chooses an active destination. Restore never
  broadens access and may narrow it beneath a stricter ancestor.

## Editor and publication contract

### Canonical document and adapter

- `@knowledge/editor` owns the canonical document schema, normalization,
  deterministic migrations, safe rendering, plain-text extraction, and the UI
  adapter contract.
- A Tiptap/ProseMirror-compatible editor may implement the UI adapter, but
  engine-specific JSON is not the persisted domain contract.
- Structured JSON is authoritative. Derived HTML and text are sanitized
  projections, never the only source of truth.
- The page title is the document's sole H1. Body headings are H2 through H6.

### Frozen Release 1 schema

The frozen schema includes:

- paragraphs; body headings; bold, italic, underline, strike, and inline code;
- ordered, unordered, and task lists;
- external and internal page links, user mentions, label references, dates,
  and simple task references;
- block quotes, dividers, callouts, and status lozenges;
- tables with header rows and accessible navigation;
- fenced code blocks with language metadata;
- image and attachment references with captions and alt text;
- expand/collapse sections and a generated table of contents.

The initial safety budgets are 1 MiB of canonical JSON, 10,000 nodes, document
depth 12, list depth 6, tables up to 200 rows by 50 columns, and URLs up to
2,048 characters. Runtime validation enforces these bounds on every untrusted
document.

### Schema evolution and deferred services

- Each persisted document retains its schema version. Supported older
  documents migrate deterministically in memory and are rewritten only after a
  successful save.
- A document newer than the client opens read-only with recoverable
  placeholders. The older client cannot save or publish it.
- An unknown node claiming the current schema version is invalid rather than
  trusted as arbitrary content.
- Service-backed nodes, including image/attachment references and live
  integrations, validate, migrate, round-trip, and render safely in M1
  fixtures. Their creation controls remain unavailable until `ATT-01`,
  `COL-01`, or another owning story supplies the required service.
- M1 never fakes an upload, notification, or Vibe JIRA database integration.

### Drafts, recovery, and conflict

- A principal may hold one private draft for each published page. Independent
  private drafts may coexist.
- Autosave remains debounced, version-checked, and visibly reports Unsaved,
  Saving, Saved, Offline, and Error states.
- The browser recovery buffer uses IndexedDB and is scoped by installation,
  organization, principal, page, and schema version. It is cleared after a
  confirmed save, logout, discard, or access revocation.
- Recovery is offered only to the same authenticated principal and is never
  applied automatically.
- Publication checks the base published revision. A conflict preserves the
  losing draft and offers compare, copy/download, refresh, and manual
  reconciliation. M1 performs no automatic structural merge.
- Publishing is always explicit and creates an immutable revision with an
  optional change summary.

### Paste, rendering, and accessibility

- Paste accepts plain text, supported Markdown patterns, and allowlisted
  semantic HTML. Input is sanitized before conversion.
- The editor never fetches remote images automatically. Unsupported embeds
  become safe text or links, and the user is warned when unsupported formatting
  is removed.
- Preview and published read mode use the same schema and sanitization rules.
- `EDT-01` requires keyboard-only authoring, screen-reader names and live
  announcements, visible focus, slash-menu navigation, accessible table
  movement, reduced-motion behavior, and responsive use at 320 CSS pixels.
- Automated accessibility checks and documented manual WCAG 2.2 AA evidence
  are both required.

## Data, API, audit, and migration contract

- M1 database changes are numbered, explicit, and forward-only.
- A clean database and an upgrade fixture from M0 must preserve existing
  organization, membership, grant, space, page, rank, draft, revision, audit,
  and outbox data. Existing slugs become initial aliases and existing draft
  owners become draft principals.
- Integration tests refuse any database whose name does not end in `_test`.
- Membership, restriction, rename, move, reorder, lifecycle, publish, and
  revision-restore mutations commit audit/outbox evidence with their domain
  change. Routine autosaves do not generate audit events.
- Logs, audit records, and outbox events contain opaque identifiers and policy
  metadata, never draft bodies, sensitive content, credentials, or signed URLs.
- Hidden and nonexistent resources return the same `404`; a visible resource
  with a disallowed action returns `403`; stale versions and publication
  conflicts return `409`; invalid input returns `422`. Each failure includes a
  stable machine-readable code without sensitive metadata.

## Evidence gates

Every execution issue runs focused checks and records exact results. Each
canonical story additionally requires:

- `npm run check` from `vibe-confluence/`;
- real PostgreSQL integration tests against an `_test` database;
- desktop and 320 CSS-pixel browser evidence with keyboard interaction;
- its story-specific authorization, concurrency, migration, recovery, safety,
  and accessibility fixtures.

M1 also requires a 10,000-page/1,000-sibling scale fixture and a clean Compose
build/start. A failed, skipped, or network-blocked check remains open and cannot
support a completion claim.

## Vibe JIRA and GitHub mapping

| Key      | Purpose                                                         | Current state |
| -------- | --------------------------------------------------------------- | ------------- |
| `KNW-9`  | M1 coordination epic                                            | To Do         |
| `KNW-10` | Record this confirmed contract and align source documentation   | Done          |
| `KNW-11` | `SPC-01` canonical story                                        | Selected      |
| `KNW-14` | Migrate memberships, restrictions, and draft principals         | Done          |
| `KNW-15` | Enforce effective permissions on every read and mutation        | Review        |
| `KNW-16` | Ship bounded membership and restriction administration          | To Do         |
| `KNW-17` | Prove adversarial access and offboarding behavior               | To Do         |
| `KNW-12` | `PGE-01` canonical story                                        | To Do         |
| `KNW-18` | Implement versioned hierarchy moves and ordering                | To Do         |
| `KNW-19` | Implement durable aliases and atomic subtree lifecycle          | To Do         |
| `KNW-20` | Ship lazy accessible tree and explicit read/edit views          | To Do         |
| `KNW-21` | Prove hierarchy concurrency, recovery, authorization, and scale | To Do         |
| `KNW-13` | `EDT-01` canonical story                                        | To Do         |
| `KNW-22` | Freeze editor schema, migrations, and adapter                   | To Do         |
| `KNW-23` | Implement rich nodes, commands, paste, and safe rendering       | To Do         |
| `KNW-24` | Preserve private drafts, recovery, and publish conflicts        | To Do         |
| `KNW-25` | Prove lossless schema and accessible authoring                  | To Do         |

The contract branch `docs/knw-10-m1-contract` was merged through
[GitHub pull request #4](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/4).
The first implementation branch, `feat/knw-14-access-data-model`, merged
through
[GitHub pull request #5](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/5).
The active branch is `feat/knw-15-effective-access`, in review through
[GitHub pull request #6](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/6).
It enforces the same server-derived visibility predicate before page projection
or mutation and does not add the membership/restriction administration owned by
`KNW-16`.
Subsequent branches follow `<type>/<tracker-key-lowercase>-<short-slug>` and
start only when their issue becomes the active work item.

## M1 non-goals

- Personal spaces, reusable groups, guests, and external invitations
- Permanent page or space deletion and automatic trash expiry
- Realtime co-editing, CRDT storage, and automatic structural merge
- Attachment upload, scanning, preview, versioning, or authorized download
- Comment threads, notification-producing mentions, and watches
- Live Vibe JIRA issue status or database access
- Search, backlinks, templates, macros, import, and export behavior owned by
  later stories
