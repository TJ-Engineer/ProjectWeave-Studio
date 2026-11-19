# ADR 0005: Baselines and deterministic evidence

- Status: Accepted
- Date: 2026-11-07

## Decision

A baseline is an immutable manifest of artifact revision identifiers, relationship versions, and relevant policy versions. Evidence exports use canonical ordering, content hashes, and a manifest hash. Signing is an adapter so installations can use their approved key service.

Creating a new baseline never modifies an earlier manifest. Corrections produce a superseding baseline with an explicit relationship to the prior one.

## Consequences

Exports are reproducible and independently verifiable. Canonical serialization and signing policy become compatibility contracts.

