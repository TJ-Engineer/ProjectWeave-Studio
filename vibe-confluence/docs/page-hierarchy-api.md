# Page hierarchy API

KNW-18 introduces bounded child-list reads and optimistic-concurrency movement
for the `PGE-01` hierarchy. UUID page routes remain canonical; all hierarchy
operations derive organization and space scope on the server.

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
