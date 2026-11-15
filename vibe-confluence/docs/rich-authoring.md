# Rich authoring

Status: KNW-23 in Review through GitHub PR #19

Vibe Knowledge edits schema-v2 documents through a project-owned
`tiptap-canonical-v2` adapter. Tiptap and ProseMirror are UI implementation
details: the adapter converts canonical JSON into engine JSON on open and
converts it back through strict canonical validation before every save or
publication. Drafts, revisions, APIs, audit records, and outbox events never
store engine JSON or arbitrary HTML.

## Authoring controls

| Content                                   | Creation path                                                       |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Bold, italic, underline, strike, code     | Named toolbar buttons and platform keyboard shortcuts               |
| Safe external link                        | Link button; absolute HTTP, HTTPS, or `mailto:` URL only            |
| H2–H6, lists, quote, divider, code block  | Slash commands and the engine's Markdown-style input rules          |
| Task list                                 | Slash command, toolbar, or `[ ] ` / `[x] ` shortcut                 |
| Callout, expand, table of contents        | Keyboard-navigable slash command menu                               |
| Callout tone/title and expand summary     | Contextual block-attribute toolbar                                  |
| Code-block language                       | Contextual `Set code language` control                              |
| Table with required header row            | Slash command; named row/column controls and Tab/Shift+Tab movement |
| Date, status, label, and internal page ID | Named safe-reference selector and Insert button                     |

Typing `/` on an empty paragraph opens a listbox. Up and Down change the
selected command, Enter inserts it, and Escape closes the menu. A polite live
announcement reports the selected command without moving focus out of the
editor. The page title remains the only H1; body heading shortcuts create H2
through H6.

Image, attachment, user-mention, and task-reference nodes load, edit around,
round-trip, preview, and publish without loss. Their creation controls are
intentionally absent until ATT-01, COL-01, or another owning story provides an
authorized service. The editor never invents an upload, notification, or live
Vibe JIRA lookup.

## Paste boundary

HTML is sanitized before Tiptap parses it. The allowlist is limited to semantic
paragraphs, H2–H6, strong/emphasis/underline/strike/code, block quotes, lists,
links, tables, dividers, preformatted code, and details/summary.

- Scripts, styles, forms, controls, frames, objects, embeds, SVG, MathML,
  audio, and video are removed.
- Inline styles, classes, event handlers, and other unsupported attributes are
  removed.
- Links retain only a safe absolute HTTP, HTTPS, or `mailto:` URL and optional
  title. Unsafe links become plain text.
- Pasted tables receive a header first row when the source lacks one.
- Every pasted image becomes an `[Image omitted: alt text]` text marker before
  insertion. No remote image URL enters the live editor or triggers a fetch.
- A visible live status lists each adjustment whenever unsupported formatting
  is removed. Fully supported semantic content produces no warning.

Plain text and supported Markdown patterns remain available through normal
paste and input rules. The canonical size, node, depth, list, table, heading,
date, UUID, label, and URL constraints still validate the converted document.
An invalid conversion disables save and publish rather than falling back to an
older body.

## Preview and published read mode

Preview calls `renderDocumentToHtml` on the current validated canonical
document. Published read mode calls the same function after loading the
immutable revision. The renderer constructs and escapes allowlisted semantic
HTML; it never passes stored or pasted HTML through. Table-of-contents entries
are generated from canonical headings in both modes.

## Accessibility and responsive behavior

- The content surface is a named multiline textbox with visible focus.
- Formatting, table, and block-attribute controls use named toolbars and
  buttons with pressed state where applicable.
- The slash listbox is operable without moving focus from the editor and
  announces its state.
- Tables support Tab and Shift+Tab cell movement plus named Previous/Next cell
  buttons as a non-implicit alternative.
- Task checkboxes, semantic headings, lists, block quotes, tables, details,
  code, status, dates, and generated navigation retain native roles.
- At 320 CSS pixels toolbars wrap, reference controls reflow, tables remain
  bounded, breadcrumbs wrap, and the document produces no page-level
  horizontal overflow.
- No animation is required for any primary interaction, so reduced-motion
  users receive the complete workflow without motion-dependent state.

## KNW-23 pre-review evidence

- The focused editor run passes two files and sixteen tests. It covers the
  complete schema through the actual Tiptap extension set, refusal to discard
  unknown engine nodes, active-content stripping, no-fetch image replacement,
  safe links, warnings, and table-header normalization.
- The real PostgreSQL integration gate passes eight files and twenty-five
  tests. The new fixture saves, publishes, reads, and re-reads the complete
  Release 1 schema without changing its node sequence or JSON.
- Desktop browser inspection proves rich fixture load, keyboard-only slash
  insertion, table creation and Tab traversal, Markdown heading conversion,
  visible paste warnings, autosave, explicit publication, and matching preview
  and published semantic output. The tested projection contains no script,
  image, or event-handler node.
- At 320 CSS pixels published and edit views each have equal body client and
  scroll widths. The published surface is 294 pixels wide and the editor
  content is 250 pixels wide without internal overflow.
- `npm run check` passes formatting, lint, strict TypeScript, twenty-seven
  non-database tests, and the production build.

GitHub PR [#19](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/19)
records the implementation and exact verification evidence. Focused review,
merge, and Vibe JIRA completion reconciliation remain required before KNW-23
is Done. KNW-24 owns IndexedDB recovery and publish-conflict workflows; KNW-25
owns the final losslessness and WCAG evidence gate.
