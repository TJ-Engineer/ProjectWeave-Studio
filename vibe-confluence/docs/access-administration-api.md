# Access administration API

Status: KNW-16 implementation contract

All routes require an authenticated identity and derive the organization and
space boundary on the server. Organization administrators and direct space
`ADMIN` members may use these routes. Request bodies use same-origin checks and
runtime validation. Error responses use the shared `{ error, correlationId }`
envelope.

## Space members

`GET /api/v1/spaces/{spaceKey}/members`

Query parameters:

- `kind`: `members` or `candidates`; defaults to `members`.
- `query`: optional display-name or email search, limited to 100 characters.
- `cursor`: optional user UUID returned by the preceding page.
- `limit`: 1–50; defaults to 20.

Member results include direct role plus unpublished-page and page-grant counts.
They never include page titles or bodies. Candidate results include only active
organization members who are not already direct members of the space.

`PUT /api/v1/spaces/{spaceKey}/members/{userId}`

```json
{
  "role": "EDITOR",
  "expectedMembershipVersion": 3
}
```

The same operation adds a direct member or changes an existing role. A stale
membership version returns `409`. Removing edit access returns `409` while the
principal owns an active unpublished page. Demoting the last active space
administrator also returns `409`.

`DELETE /api/v1/spaces/{spaceKey}/members/{userId}`

```json
{
  "expectedMembershipVersion": 4
}
```

Removal is atomic with policy-version advancement, audit/outbox evidence, and
cascading deletion of the principal's page-allowlist entries. The response
reports the affected grant count without revealing page metadata. Re-adding a
principal does not restore deleted grants.

## Page restrictions

`GET /api/v1/pages/{pageId}/restriction`

Returns the visible page and space summaries, whether the direct restriction is
enabled, its policy version, and the allowed direct-member UUIDs. The route uses
the same hidden-resource `404` behavior as other page routes.

`PUT /api/v1/pages/{pageId}/restriction`

```json
{
  "restricted": true,
  "memberIds": ["018f4f9e-37d8-7a1f-b465-87a8d5cdf11f"],
  "expectedVersion": 1
}
```

The allowlist is replaced atomically. Every UUID must identify an active direct
space member. An empty enabled allowlist permits only organization and space
administrators. Disabling a restriction requires an empty `memberIds` array and
retains the policy row/version so an older client cannot recreate stale access.
Ancestor restrictions continue to intersect with the page restriction; a child
cannot reopen access.

## Emergency organization deactivation

Changing an organization user's persisted state from `ACTIVE` to `DEACTIVATED`
is an emergency revocation boundary. Migration `0005` atomically removes that
user's direct space memberships, cascades their page-allowlist entries, and
advances every affected membership and page-policy version. It may leave a
space without an active administrator because emergency deactivation overrides
the ordinary last-admin blocker; an organization administrator must then make
an explicit recovery decision.

Pages, drafts, revisions, and authorship remain intact and private. Changing
the user back to `ACTIVE` does not restore memberships or grants. Administrators
must explicitly re-add access, and stale clients receive `409 VERSION_CONFLICT`
instead of recreating a pruned allowlist.

## Stable failures

- `403 FORBIDDEN`: the resource is visible but the actor cannot administer it.
- `404 NOT_FOUND`: the space/page is absent or hidden by policy.
- `409 VERSION_CONFLICT`: membership or restriction policy changed.
- `409 LAST_SPACE_ADMIN`: the requested change removes the last active admin.
- `409 UNPUBLISHED_PAGE_OWNER`: removal or edit-capability loss is blocked.
- `409 INVALID_RESTRICTION_MEMBER`: an allowlist principal is no longer active
  or no longer a direct member.
- `422 VALIDATION_ERROR`: a path, query, or body value is invalid.
