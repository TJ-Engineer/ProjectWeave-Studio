# ADR 0002: Restrictive access and private drafts

Date: 2026-10-18

Status: Accepted

## Context

M1 introduces team-space membership and page-level visibility while preserving
the publication proof's private working state. Additive page grants and broad
administrator draft access would be convenient, but they make inherited policy
harder to reason about and turn administration into an implicit content-access
path.

## Decision

M1 spaces are private and use direct `ADMIN`, `EDITOR`, and `VIEWER`
memberships. A page restriction is a direct-user allowlist that can only narrow
space access; descendant restrictions intersect with ancestor restrictions and
can never reopen access. Organization and space administrators manage policy
and published content, but another principal's unpublished pages and private
drafts remain inaccessible. Normal offboarding is blocked by owned unpublished
pages; emergency organization deactivation revokes access and seals that work
without exposing or transferring it.

## Consequences

Every read projection must apply the same effective policy before pagination or
metadata is produced, and hidden content must be indistinguishable from missing
content. M1 deliberately defers personal spaces, reusable groups, guests,
additive page grants, and private-draft transfer. Restoring a removed member or
reactivating a user requires explicit membership and page-policy decisions
rather than silently reviving historical access.
