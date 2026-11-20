# OpenRM self-verification project

## Purpose

The `OPENRM` project is OpenRM's controlled product-requirement baseline. It dogfoods the platform by loading the repository's system requirements, derived requirements, decomposition trace, independent review, and signed verification evidence through the public API.

The source catalog is [`data/openrm-self-verification/requirements.json`](../../data/openrm-self-verification/requirements.json). The loader is [`scripts/bootstrap-openrm-self-project.mjs`](../../scripts/bootstrap-openrm-self-project.mjs).

## Controlled scope

| Evidence item | Required result |
| --- | ---: |
| System-level requirements | 12 |
| Derived requirements | 48 |
| Total requirements | 60 |
| `DECOMPOSES_TO` relationships | 48 |
| Orphan requirements | 0 |
| Suspect relationships at baseline | 0 |
| Independent verification cases | 4 |
| Linked evidence attachments | 71 |
| Exact-revision verification coverage | 100% |
| Gate readiness | Ready with no blockers |

Every system requirement decomposes to exactly four derived requirements. Every derived requirement has exactly one system parent. Requirement attributes identify level, subsystem, priority, verification method, and evidence group.

## Verification methods

The four immutable verification cases provide complete baseline coverage:

1. **Automated test** — Rust and web unit tests, authenticated PostgreSQL workflows, tenant isolation, immutable evidence controls, browser workflows, and WCAG 2 A/AA automation.
2. **Operational test** — load/soak, backup/restore, upgrade, production-topology, clean-volume portable-stack, and hardened-container evidence.
3. **Analysis** — implementation allocation, architecture decisions, threat model, security review, and operating-boundary analysis.
4. **Observation/inspection** — built product surfaces, three-browser evidence, status presentation, and operator procedures. OpenRM stores this as the supported `inspection` verification method while the catalog retains the stakeholder term `observation`.

Each completed result contains repository links, media types, byte sizes, and SHA-256 hashes for its unit tests, end-to-end tests, scripts, architecture records, security records, and operating documents. Evidence links remain human-navigable; hashes preserve exact content identity.

## Reproduce the project

Validate the catalog and every referenced evidence file without an API:

```bash
npm run check:self-project
```

With a migrated OpenRM API listening on `http://127.0.0.1:8080` in development authentication mode:

```bash
npm run bootstrap:self-project
```

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENRM_API_BASE_URL` | `http://127.0.0.1:8080` | OpenRM API origin. |
| `OPENRM_ORGANIZATION_ID` | Local development organization | Tenant receiving the project. |
| `OPENRM_AUTHOR_TOKEN` | `dev:openrm-project-author` | Administrator identity that authors the baseline and review package. |
| `OPENRM_VERIFIER_TOKEN` | `dev:openrm-independent-verifier:reviewer` | Independent reviewer identity that approves and executes verification. |
| `OPENRM_VERIFIER_SUBJECT` | `openrm-independent-verifier` | Membership and verification-owner subject. |
| `OPENRM_REPOSITORY_URL` | OpenRM GitHub repository | Base URL for linked evidence. |
| `OPENRM_EVIDENCE_REF` | `GITHUB_SHA` or `main` | Git ref used in evidence links. Hosted runs automatically use their immutable commit SHA. |
| `OPENRM_SELF_EVIDENCE_RUN_URL` | Current GitHub run or local marker | Hosted or local execution record stored with measured values. |
| `OPENRM_SELF_EVIDENCE_VERSION` | Hash of all linked evidence | Optional explicit identifier for a new verification execution. |

The loader is idempotent for the immutable `v1` requirement catalog and each evidence hash. Requirement changes must use OpenRM's governed revision workflow and a new controlled baseline; they must not overwrite this catalog release in place. If linked evidence changes, the loader automatically records a new verification execution while preserving earlier signed results.

## Hosted evidence

[OpenRM CI run 42512977538](https://github.com/TJ-Engineer/OpenRM/actions/runs/42512977538) reconstructed this project from a clean PostgreSQL 17 database and passed the complete protected `database-path` gate. The same run passed the API, web, recovery-rehearsal, and hardened production-artifact jobs.

[OpenRM CI run 42518730569](https://github.com/TJ-Engineer/OpenRM/actions/runs/42518730569) additionally built the complete portable container distribution and reconstructed the project through its migration and bootstrap containers on a clean volume. The hosted smoke gate verified same-origin web/API readiness, all 60 requirements, non-root users, read-only root filesystems, and dropped Linux capabilities.

## Independence and integrity

- The author identity creates the project, requirements, trace, changeset, baseline, and review package.
- A separate reviewer identity approves the package and executes all verification cases.
- Verification targets bind to exact baseline artifact revisions.
- Results and attachment manifests are signed and append-only.
- Direct changes to requirements history, relationships, baselines, reviews, verification results, and attachments remain rejected by database controls.

## Operating boundary

Repository verification demonstrates implementation completeness and pilot readiness. It does not claim that a specific production tenant has completed OIDC commissioning, secret delivery, encrypted PITR, alert routing, retained trace storage, Jira service-identity approval, or independent penetration testing. Those remain environment acceptance conditions.
