# ADR 0004: Canonical editor schema boundary

Date: 2026-10-18

Status: Accepted

## Context

The Release 1 document language must survive editor-library upgrades, older and
newer clients, deferred attachment and notification services, and future
realtime collaboration. Persisting a library-native document or allowing older
clients to rewrite unknown content would make those changes lossy and difficult
to reverse.

## Decision

`@knowledge/editor` owns a bounded canonical structured-document schema,
deterministic forward migrations, normalization, safe rendering, plain-text
extraction, and an adapter contract. A Tiptap/ProseMirror-compatible editor may
implement the UI but its engine-specific JSON is not the domain contract.
Newer-than-client documents are recoverable and read-only; unknown nodes that
claim the current schema are invalid. Service-backed nodes round-trip and
render safely before their creation controls are enabled by the story that owns
the required service.

## Consequences

The application pays an explicit adapter and migration cost instead of coupling
stored knowledge to one editor implementation. Schema fixtures and backward
compatibility become release gates. M1 can freeze the complete Release 1
document vocabulary without faking attachment upload, notification delivery,
or Vibe JIRA integration.
