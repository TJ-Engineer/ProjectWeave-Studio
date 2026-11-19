# ADR 0002: Append-only revisions with materialized current state

- Status: Accepted
- Date: 2026-11-07

## Decision

Controlled artifacts use immutable revision rows. A materialized current-state row points to the latest accepted revision for efficient queries. Commands use optimistic concurrency against the known revision and append an audit event in the same transaction.

Deletion creates a tombstone revision; it does not erase controlled history. Administrative retention operations are separate, privileged workflows.

## Consequences

History and comparisons are deterministic, while common reads remain efficient. Mutations require transactional enforcement and explicit concurrency errors.

