# Canonical editor schema

Status: KNW-22 implementation contract

`@knowledge/editor` is the sole owner of persisted structured-document syntax.
The contract is independent of Tiptap, ProseMirror, or any other editing
engine. UI integrations implement `CanonicalEditorAdapter`; engine-only JSON
must not cross the adapter into drafts, revisions, audit data, or API payloads.

## Versions and compatibility

The current canonical schema version is `2`.

| Stored version | Behavior                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| `1`            | Parse the original heading/paragraph format and migrate in memory to v2. |
| `2`            | Validate strictly, normalize deterministically, and open for editing.    |
| `>2`           | Preserve the opaque source and expose safe read-only placeholders.       |

Supported older documents are rewritten only after a successful save,
publication, or restore. An unknown node that claims schema version 2 is an
error; it is never downgraded to a placeholder and never silently discarded.
Fixtures for every supported version and a future-version recovery fixture are
under `tests/fixtures/editor/`.

## Frozen Release 1 vocabulary

The page title is the only H1. Body headings are levels 2 through 6.

| Kind       | Canonical nodes                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| Inline     | text; page link; user mention; label reference; date; task reference; status |
| Text marks | bold; italic; underline; strike; inline code; safe external link             |
| Blocks     | paragraph; heading; block quote; divider; callout; code block                |
| Lists      | ordered; unordered; task list                                                |
| Tables     | equal-width rows with a required header row                                  |
| References | image and attachment metadata with stable asset UUIDs                        |
| Structure  | expand/collapse section; generated table of contents                         |

Images and attachments deliberately contain metadata only. Their renderers do
not issue download URLs, and creation controls remain unavailable until the
owning attachment story provides authorized storage and scanning.

## Runtime limits

Every untrusted current document is validated before persistence or rendering.

| Boundary       | Limit                                  |
| -------------- | -------------------------------------- |
| Canonical JSON | 1 MiB, measured as UTF-8 bytes         |
| Nodes          | 10,000 including structural nodes      |
| Document depth | 12                                     |
| List depth     | 6                                      |
| Table size     | 200 rows by 50 columns                 |
| Body headings  | H2 through H6                          |
| URLs           | 2,048 characters; HTTP(S) or `mailto:` |

Tables must have a header first row and a stable column count. Current-version
objects are strict: unknown keys, nodes, marks, unsafe URLs, and out-of-budget
documents fail validation.

## Projections

- `normalizeDocument` produces stable mark ordering and removes exact duplicate
  marks.
- `extractPlainText` is the text/search/diff projection.
- `renderDocumentToHtml` validates first and escapes all user-authored values.
  It emits semantic headings, lists, tables, code, figures, details, and a
  generated table of contents. It never renders raw HTML from the document.
- `openDocument` distinguishes editable supported input from recoverable
  future input.
- `openWithAdapter` prevents an adapter that cannot represent a valid canonical
  document from editing it lossily.

The current simple heading/paragraph UI is one adapter implementation. Rich
creation commands, paste conversion, and full authoring interaction belong to
KNW-23; private recovery and conflict behavior belong to KNW-24.

## KNW-22 verification

- `npm run check` passes formatting, lint, strict TypeScript, twenty-one
  non-database tests, and the production build.
- The focused editor/domain run passes sixteen tests. It covers every schema
  version fixture, the complete vocabulary, normalization, all confirmed
  budgets, unsafe nodes and URLs, safe rendering, future recovery, and adapter
  isolation.
- The real PostgreSQL integration gate passes eight files and twenty-four
  tests. The added fixture proves that a persisted v1 draft migrates in memory
  without a write and changes its JSON and schema-version column to v2 only
  after a successful version-checked save. A future-version fixture opens
  read-only, rejects save and publish with `DOCUMENT_SCHEMA_NEWER`, and retains
  its opaque JSON unchanged.
- Desktop browser inspection renders a schema-v2 heading, escaped external
  link text, status, callout, header-row table, and generated table of contents
  with no script element. The minimal editor exposes the same rich document as
  read-only, with no editor inputs or Publish control, rather than discarding
  unsupported canonical nodes. A live schema-v3 draft renders only its safe
  versioned placeholder with no editor inputs or Publish control.
- At 320 CSS pixels the published projection has a 320-pixel client and scroll
  width; its document surface has matching 294-pixel client and scroll widths.

No database migration or editor-engine dependency is introduced. The version
is carried in both the canonical JSON and the existing draft/revision schema
columns.
