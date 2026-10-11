# ADR 0001: First-slice architecture

Status: accepted

## Context

The repository contains a Flask/React/SQLite issue-board prototype. The Vibe JIRA implementation plan instead calls for a strict-TypeScript modular monolith, PostgreSQL, server-owned workflow rules, durable history, and production-oriented container delivery.

## Decision

- The prototype remains reference-only and is not imported or migrated in place.
- The new application lives entirely under `vibe-jira/`.
- Next.js App Router supplies the browser application and versioned JSON API from one origin.
- PostgreSQL is the only durable store. SQL migrations are explicit one-shot commands.
- Packages separate runtime contracts, deterministic domain rules, and database operations.
- All state transitions are authorized and validated on the server, use optimistic concurrency, and commit the issue update, history event, and outbox event atomically.
- Release 1 will use REST, signed server sessions initially, Markdown descriptions, and PostgreSQL-native search. Production identity will be replaced with managed OIDC before launch.

## Consequences

The first slice duplicates some visible prototype behavior, but it establishes the required identity, tenancy, workflow, audit, concurrency, and deployment seams before broader features are added.
