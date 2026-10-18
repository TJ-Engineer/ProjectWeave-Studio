# ADR 0003: Durable page identity and subtree lifecycle

Date: 2026-10-18

Status: Accepted

## Context

Readable paths, hierarchical restrictions, concurrent ordering, and reversible
lifecycle changes pull page identity in different directions. Treating a path
or slug as identity would break links on rename or move, while recomputing
access after a move could silently expose a previously restricted subtree.

## Decision

A page UUID is canonical and readable slugs are permanently reserved aliases.
Rename regenerates a slug without invalidating an older alias. Moves and
reorders use versioned sibling lists and atomic source/destination checks; when
a move would otherwise broaden access, the prior effective allowlist is
materialized on the moved root. Archive, trash, and restore are atomic subtree
transitions that preserve restrictions, drafts, and revisions. M1 provides no
permanent delete or automatic trash expiry.

## Consequences

Alias storage grows monotonically and slug reuse is intentionally constrained.
Move and restore operations must evaluate access and hierarchy together rather
than as separate best-effort updates. Administrators receive explicit conflicts
instead of last-write-wins ordering, and a restore may require selection of a
new active parent when the original location is no longer valid.
