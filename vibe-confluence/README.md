# Vibe Knowledge

Vibe Knowledge is ProjectWeave's self-hostable team knowledge workspace. The
current first slice proves private draft autosave, explicit immutable
publication, comparison, and restore-as-new-revision.

## Development

Requirements: Node.js 20.9 or newer and PostgreSQL 16 or newer.

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3100` and use the development credentials configured in
`.env`. Development login is unavailable unless
`ENABLE_DEVELOPMENT_LOGIN=true`.

### Container development

The Compose stack starts PostgreSQL, an S3-compatible SeaweedFS object store,
the migration and seed jobs, the web application, and the background worker:

```sh
docker compose up --build -d
docker compose ps --all
```

Open `http://localhost:3100` and use the development credentials configured in
`.env`, or the Compose-only defaults `admin@example.test` and
`development-password`. Replace every default credential outside an isolated
development environment.

The object store is private to the Compose network. Application containers use
its S3 API at `http://object-storage:8333`; no object-storage port is published
to the host.

## Quality gates

```sh
npm run check
TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5433/knowledge_test npm run test:integration
TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5433/knowledge_test npm run test:load
```

Integration tests refuse to use a database whose name does not end in `_test`.

## Current boundaries

- Vibe Knowledge owns its database and migrations.
- Vibe JIRA and Vibe Knowledge may share external OIDC subject claims but never
  query each other's databases.
- `@knowledge/editor` freezes the complete Release 1 canonical vocabulary,
  deterministic v1-to-v2 migration, safety budgets, safe projections, and UI
  adapter boundary. The current heading-and-paragraph UI remains intentionally
  minimal until KNW-23 and never persists engine-native JSON or arbitrary HTML.
- Comments, attachments, search, macros, import/export, realtime editing, and
  cross-product embeds are intentionally later stories.

M1 is confirmed as `SPC-01` → `PGE-01` → `EDT-01`. Its private-space,
restrictive-access, hierarchy, lifecycle, editor-schema, and evidence rules are
recorded in the
[`M1 spaces and authoring contract`](./docs/m1-spaces-and-authoring-contract.md).
The versioned membership and page-restriction endpoints are documented in the
[`access administration API`](./docs/access-administration-api.md).
Bounded, permission-filtered tree navigation, explicit read/edit routes, and
versioned subtree movement are documented in the
[`page hierarchy API`](./docs/page-hierarchy-api.md).
The hierarchy concurrency, recovery, non-disclosure, scale, and load gate is
recorded in the [`PGE-01 evidence record`](./docs/pge01-evidence.md).
The frozen document vocabulary, compatibility behavior, limits, projections,
and adapter boundary are documented in the
[`canonical editor schema`](./docs/editor-schema.md).
Durable readable aliases, archived reads, and reversible atomic subtree
transitions are documented in the
[`page alias and lifecycle API`](./docs/page-lifecycle-api.md).
Implementation proceeds through one active Vibe JIRA issue, GitHub branch, and
pull request at a time.

See [`DEVELOPMENT_STORYBOARD.md`](./DEVELOPMENT_STORYBOARD.md) for verified
status and [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the release
plan.
