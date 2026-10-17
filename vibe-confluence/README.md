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

## Quality gates

```sh
npm run check
TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5433/knowledge_test npm run test:integration
```

Integration tests refuse to use a database whose name does not end in `_test`.

## Current boundaries

- Vibe Knowledge owns its database and migrations.
- Vibe JIRA and Vibe Knowledge may share external OIDC subject claims but never
  query each other's databases.
- The minimal editor supports a versioned heading-and-paragraph document while
  the publication model is proven. It does not accept arbitrary HTML.
- Comments, attachments, search, macros, import/export, realtime editing, and
  cross-product embeds are intentionally later stories.

See [`DEVELOPMENT_STORYBOARD.md`](./DEVELOPMENT_STORYBOARD.md) for verified
status and [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the release
plan.
