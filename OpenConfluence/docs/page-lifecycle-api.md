# Page alias and lifecycle API

KNW-19 adds durable readable aliases and reversible subtree lifecycle
transitions to the canonical UUID page model. Every operation derives the
organization, space, hierarchy, permissions, and content state on the server.
There is no permanent-delete endpoint.

## Resolve a readable alias

`GET /api/v1/spaces/{spaceKey}/pages/{slug}`

The response identifies the canonical UUID path, current slug, and active or
archived state. The browser route at `/spaces/{spaceKey}/pages/{slug}` uses the
same authorization check and redirects to `/pages/{pageId}`.

Publishing a changed title regenerates the current slug. Restoring a revision
whose title differs does the same. Every generated slug remains permanently
reserved in that space for the same page. A page may reuse one of its own
historical aliases; a collision owned by another page receives the lowest
available deterministic numeric suffix.

Alias lookup applies effective page policy before returning an identifier.
Active and archived aliases resolve; trashed, hidden, and nonexistent aliases
all return `404 NOT_FOUND`.

## Read an archived publication

`GET /api/v1/pages/{pageId}/published`

The response contains the current immutable revision and a `readOnly: true`
marker. It is available only for authorized published pages in `ACTIVE` or
`ARCHIVED` state. The canonical browser route renders archived content as
read-only text through the validated structured document model. It never
returns another principal's draft.

## Change a subtree lifecycle

`POST /api/v1/pages/{pageId}/lifecycle`

Archive or trash an active subtree:

```json
{
  "action": "ARCHIVE",
  "expectedVersion": 4,
  "expectedParentVersion": 7
}
```

Restore to the original active parent and retained relative rank:

```json
{
  "action": "RESTORE",
  "expectedVersion": 5,
  "expectedParentVersion": 8
}
```

The transition records the nearest active siblings around its root. Restore
uses surviving anchors, with the retained fractional rank as a deterministic
fallback, so later rank maintenance does not silently move the page to an
unrelated position. If the original parent is no longer active, an
administrator must select an active destination. Neighbor IDs describe the
insertion point after excluding the restored root; both are `null` to append.

```json
{
  "action": "RESTORE",
  "expectedVersion": 5,
  "expectedParentVersion": 3,
  "destinationParentId": "00000000-0000-4000-8000-000000000001",
  "beforePageId": null,
  "afterPageId": null
}
```

The transaction locks the space, lifecycle subtree, and affected sibling list;
checks the root and sibling-list versions; validates lifecycle, ownership,
publication, destination, and neighbor rules; updates every selected page; and
commits one content-free audit/outbox event. A transition changes the sibling
list version exactly when the root enters or leaves active navigation.

Subtrees are selected through pages in the root's current lifecycle state. A
previously trashed branch below an active parent therefore remains trashed when
the parent is archived. This allows that branch to require the documented
fallback restore if its original parent is no longer active.

## Permissions and retained data

- Organization and space administrators may archive published subtrees and may
  trash or restore published subtrees.
- Editors may trash or restore only a wholly never-published subtree that they
  own page-for-page.
- Any operation that reaches another principal's unpublished page is rejected
  with only the count of affected private pages.
- Archive requires every selected page to be published.
- Drafts, immutable revisions, aliases, restrictions, and future attachment
  references remain in place; lifecycle changes update page state rather than
  deleting related records.
- Before a published subtree leaves an inherited restriction boundary, the
  prior effective allowlist is materialized on its root when needed. A fallback
  restore repeats the comparison, so restore never broadens access and may
  narrow it under a stricter destination.

## Stable failures

- `403 FORBIDDEN`: the page is visible but the requested lifecycle action is
  not allowed.
- `404 NOT_FOUND`: the page, alias, or selected destination is missing or
  hidden; trashed content is also absent from normal reads.
- `409 PAGE_VERSION_CONFLICT`: the lifecycle root changed.
- `409 SIBLING_LIST_VERSION_CONFLICT`: the affected active list changed.
- `409 PAGE_STATE_CONFLICT`: the action does not apply to the current state.
- `409 SUBTREE_PRIVATE_DRAFTS`: the selected subtree includes unpublished work
  owned by another principal; the message contains a count but no content.
- `422 SUBTREE_UNPUBLISHED`: archive encountered unpublished pages.
- `422 RESTORE_DESTINATION_REQUIRED`: the original parent is inactive and no
  fallback was selected.
- `422 RESTORE_DESTINATION_INVALID`: a fallback was supplied even though the
  original parent is still active.
- `422 PAGE_POSITION_INVALID`: supplied fallback neighbors are not current and
  adjacent.
