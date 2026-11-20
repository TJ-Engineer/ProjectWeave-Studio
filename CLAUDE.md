# ProjectWeave Studio — instructions for agents

ProjectWeave Studio is a self-hostable software-factory suite maintained in a
single Git repository. The active applications are:

- `OpenConfluence/` — knowledge spaces, pages, publication, and governance;
- `OpenJira/` — projects, issues, workflows, boards, and delivery tracking;
- `OpenRM/` — requirements, traceability, controlled change, reviews, and
  verification evidence.

Follow [`AGENTS.md`](./AGENTS.md) for the repository-wide rules. When an
application contains a more specific `AGENTS.md`, follow it for work in that
application.

## Start every session here

1. Identify the application or suite-level boundary affected by the task.
2. Read the target application's `README.md`, development storyboard or
   dashboard, implementation plan, and relevant documentation.
3. Inspect the existing implementation and tests before changing behavior or
   architecture.
4. Preserve unrelated working-tree changes and do not create commits unless the
   user requests one.

## Application boundaries

- Each application owns its source, domain model, API, runtime configuration,
  database schema, migrations, and product documentation.
- Applications integrate through authenticated REST APIs or durable events.
  They must not read or write another application's database directly.
- Shared identity claims or root packages must remain provider-neutral and must
  not collapse application authorization boundaries.
- Root-level content is reserved for suite-wide documentation, agent guidance,
  CI, orchestration, and proven shared assets.

## Validation

Run commands from the application being changed.

### OpenConfluence

```sh
cd OpenConfluence
npm run check
TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5433/knowledge_test npm run test:integration
```

### OpenJira

```sh
cd OpenJira
npm run check
docker compose --profile test run --rm test
npm run test:e2e
```

### OpenRM

```sh
cd OpenRM
npm run check
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

Use an isolated database whose name ends in `_test` for integration tests.
Never weaken or remove a quality gate merely to make a change pass.

## Security and reliability

- Never commit credentials, local environment files, dependency directories,
  generated runtime data, or private evidence.
- Validate untrusted input at runtime and enforce authorization, tenant scope,
  workflow rules, and data integrity on the server.
- Preserve optimistic concurrency, idempotency, audit, history, and outbox
  behavior where already supported.
- Carry correlation IDs through cross-application agent operations so audit
  evidence can be reconciled.

## Documentation

- Keep suite-level links and commands aligned with the canonical
  `OpenConfluence/`, `OpenJira/`, and `OpenRM/` paths.
- Keep application-specific implementation and operational documentation with
  its owning application.
- Update API contracts, generated references, storyboards, and evidence claims
  when a change affects them.
- Record consequential architectural decisions in the owning application's ADR
  or decision directory.
