# ADR 0001: Application and publication boundaries

Date: 2026-10-16  
Status: Accepted

## Context

Vibe Knowledge belongs to the ProjectWeave suite but has different data,
operational, and release concerns from Vibe JIRA. Knowledge publication also
needs a durable distinction between acknowledged working state and immutable
shared history.

## Decision

- Vibe Knowledge is a separately deployable TypeScript workspace with its own
  PostgreSQL database and forward-only migrations.
- It may use the same OIDC provider and stable external subject claims as Vibe
  JIRA, but neither application reads the other's database.
- An autosave mutates only its owner's draft. It never updates the page's
  published head.
- Publish and restore acquire the page row, verify the expected head, append an
  immutable revision, update the head, and append audit and outbox evidence in
  one transaction.
- Realtime collaboration and cross-product embeds remain outside Release 1.

## Consequences

The applications can be upgraded, restored, and scaled independently. A future
suite identity service or cross-product link service must use explicit APIs or
identity claims rather than database coupling. Publication conflicts are
visible to users and cannot silently replace committed work.
