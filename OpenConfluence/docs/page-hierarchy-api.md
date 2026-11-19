# Page hierarchy API

KNW-18 introduces bounded child-list reads and optimistic-concurrency movement
for the `PGE-01` hierarchy. UUID page routes remain canonical; all hierarchy
operations derive organization and space scope on the server.

KNW-20 uses those contracts for the permission-filtered navigation surface and
keeps reading separate from draft editing. No tree response or published read
contains another principal's private draft.

## Navigation and page routes

The space page renders a semantic tree from the bounded root response. Children
load only when their parent is expanded, 50 at a time, and an explicit Load more
control requests the next page. The client retains expanded and roving-focus
state while children load or an administrator reorders a loaded sibling.

Keyboard behavior follows the tree pattern:

- Up and Down move focus through visible items.
- Right expands a parent or moves to its first loaded child.
- Left collapses a parent or returns focus to its parent.
- Home and End move to the first and last visible items.
- Enter opens the canonical page; Space toggles an expandable item.

Administrators also receive labelled Move up and Move down buttons, so reorder
never depends on drag input. Controls remain usable with pointer, keyboard, and
touch at desktop and 320 CSS pixels.

`/pages/{pageId}` is the canonical read route for an authorized published page.
It returns only the immutable published revision and exposes an Edit link only
when the server-derived `page:edit` capability is present. An authorized
principal's own unpublished page redirects to `/pages/{pageId}/edit`; viewers
cannot request a workspace or cause a private draft row to be created.

Tree authorization is applied before pagination. Results include authorized
published pages and only the current principal's own unpublished pages. Hidden
titles, ranks, paths, and counts are not sent to the browser.

The parent authorization check establishes inherited policy once. The bounded
child query then evaluates only each direct child's own restriction and
private-draft ownership rule, including for the `hasChildren` projection. This
set-based boundary preserves the same policy semantics without recursively
re-evaluating the full ancestor path for every sibling. The 10,000-page and
1,000-sibling regression gate is documented in
[`pge01-evidence.md`](./pge01-evidence.md).

## Read a child list

`GET /api/v1/spaces/{spaceKey}/tree`

Query parameters:

- `parentId`: optional page UUID; omit it for roots.
- `cursor`: optional page UUID returned by the previous response.
- `limit`: 1–100, default 50.

The response contains the direct children only, their accessible-child flag,
the canonical root-to-parent breadcrumbs, the sibling-list `parentVersion`, and
an optional `nextCursor`. Titles, ranks, child counts, and breadcrumbs from
inaccessible pages are never returned.

## Move or reorder a subtree

`POST /api/v1/pages/{pageId}/move`

```json
{
  "destinationParentId": "uuid-or-null",
  "beforePageId": "uuid-or-null",
  "afterPageId": "uuid-or-null",
  "expectedSourceVersion": 4,
  "expectedDestinationVersion": 7
}
```

`beforePageId` and `afterPageId` describe the adjacent pages at the requested
destination after excluding the moving page. Both are `null` to append. Only an
organization or space administrator may move pages, and cross-space movement
is rejected.

The transaction locks the source and destination sibling lists, checks both
versions, validates tenant, space, lifecycle, neighbors, and cycles, assigns a
fractional rank, and advances the affected list versions. If numeric space is
exhausted, only the destination list is deterministically rebalanced. The page
move and content-free `page.moved` audit/outbox events commit atomically.

Moving a subtree cannot broaden inherited access. When the destination policy
would admit a direct member who was denied before the move, the prior effective
allowlist is materialized as a restriction on the moved root. A stricter
destination may still narrow access.

## Stable failures

- `403 FORBIDDEN`: the page is visible, but the actor cannot move it.
- `404 NOT_FOUND`: the source or destination is missing or hidden.
- `409 SIBLING_LIST_VERSION_CONFLICT`: either sibling list changed.
- `409 PAGE_CYCLE`: the destination is inside the moving subtree.
- `409 PAGE_HIERARCHY_CHANGED`: a locked source or destination changed.
- `409 HIERARCHY_STATE_INVALID`: sibling-list state is missing.
- `422 CROSS_SPACE_MOVE`: the destination belongs to another space.
- `422 PAGE_POSITION_INVALID`: the supplied neighbors are not current and
  adjacent.
- `409 PAGE_ANCESTOR_UNPUBLISHED`: publication was attempted before every
  ancestor had a published revision.
