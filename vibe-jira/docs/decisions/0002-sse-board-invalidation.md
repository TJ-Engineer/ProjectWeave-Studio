# ADR 0002: SSE for board invalidation

- Status: accepted
- Date: 2026-10-12
- Story: `BRD-06`

## Context

Board clients need to notice committed issue and WIP-setting changes made in other sessions. Release 1 does not require clients to send messages over the realtime connection, and canonical board state must continue to come from the versioned JSON API.

## Decision

Use authenticated server-sent events (SSE) as a project-scoped invalidation channel. PostgreSQL row triggers publish compact notifications only after their transaction commits. One application listener connection fans those notifications out to authorized SSE subscribers. Clients compare per-entity versions, suppress stale or duplicate events, coalesce refreshes, and fetch the canonical board model. A sync event on every connection or listener reconnection closes the gap for notifications missed while disconnected.

## Consequences

- SSE uses the existing same-origin session cookie and needs no second bidirectional protocol.
- Notifications are hints, not the source of truth; reconnecting clients always resynchronize.
- PostgreSQL remains the cross-process fan-out point, so multiple application instances observe committed changes.
- The connection includes heartbeat comments for intermediary timeouts and browser-native retry behavior.
- Durable notification delivery and general outbox consumption remain separate work in `WFL-04`.
