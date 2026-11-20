# Member guide

## Work from the board

Choose a project, then create an Epic, Story, Task, Bug, or Subtask. Issues support sanitized Markdown descriptions, priority, assignee, labels, estimate points, due date, and validated parent relationships. Open a card for details, activity, comments, attachments, and watch controls.

Stories can also have an ordered **Completion actions (COAs)** checklist. Add the required actions while creating a Story or from its issue drawer; each action creates a normal Task that is visible on the board. The checklist shows completed/total progress and links to every generated Task. Members with the corresponding issue permissions can rename, reorder, add, remove, and check actions without pointer-only interaction.

A checkbox is checked when its generated Task is in a Done workflow category. If the Task does not yet have one direct transition to Done, open it from the checklist and advance it through the board until that transition is available. Open COAs prevent the Story from moving to Done. Reopen a Done Story before unchecking or removing an action; generated Tasks cannot be deleted or structurally changed independently from their Story checklist.

Move cards by pointer or touch, or use the visible previous/next buttons and keyboard ordering controls. The server owns workflow validation and rank. If another user wins a concurrent update, Vibe JIRA restores canonical state and asks you to retry. WIP limits warn; they do not block a valid transition.

Use assignee or epic swimlanes and board filters for focused views. Filter and swimlane choices stay in the URL so the view can be shared.

## Find and follow work

- **Search** supports text plus project, type, status/category, priority, assignee, reporter, label, parent, and date filters with stable pagination and sorting.
- Save a filter privately, for a project, or for the organization when your role permits it.
- Mentions use an active project user's full `@email`. Watching an issue delivers eligible comment notifications; muting remains durable.
- Notification preferences control mention and watched-comment classes. Inbox items can be marked individually or all at once.

## Content and files

Descriptions support headings, bold, inline code, lists, and safe HTTP/HTTPS/mail links. Raw HTML and unsafe URL schemes are rendered as text or omitted. Attachments are private, malware-scanned, limited to 10 MiB and approved document/image/text formats, and downloaded with short-lived links.

Viewer access is read-oriented. Members can create, edit, comment, attach, and transition. Project administrators also configure access, workflows, boards, data jobs, deleted-issue restoration, and reports.
