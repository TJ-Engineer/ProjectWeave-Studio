# Vibe JIRA

Vibe JIRA is the new implementation described by `IMPLEMENTATION_PLAN.md`. The repository-level `backend/` and `frontend/` applications are disposable prototypes and are not dependencies of this application.

Development status, upcoming stories, release-gate coverage, and risks are tracked in [`DEVELOPMENT_STORYBOARD.md`](./DEVELOPMENT_STORYBOARD.md).

This first vertical slice supports:

- local email/password authentication with signed, HTTP-only sessions;
- organization and project membership with named capability checks;
- project creation with a default workflow and three-column Kanban board;
- stable project issue keys;
- task creation;
- pointer, touch, and keyboard-accessible issue movement;
- server-validated, optimistic transitions with version conflict detection;
- atomic status/rank/version/history/outbox writes;
- an issue activity drawer;
- explicit PostgreSQL migrations, demo seed data, and container health checks.

## Run with Docker

```sh
cp .env.example .env
# Replace every placeholder in .env.
docker compose up --build
```

Open `http://localhost:3000` and sign in with `DEMO_ADMIN_EMAIL` and `DEMO_ADMIN_PASSWORD` from `.env`.

Migrations and seed data run as one-shot services using the same application image. PostgreSQL data is stored in the `postgres-data` volume; rebuilding the application image does not remove it.

## Local development

Node.js 20.9 or newer and PostgreSQL are required.

```sh
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Important commands:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
docker compose --profile test run --rm test
```

The browser test covers authentication, task creation, a board transition, refresh-persisted history, and a serious/critical Axe accessibility scan. Integration tests refuse to run against a database whose name does not end in `_test`.

## Current boundary

This is the implementation plan's first slice, not Release 1. Comments, attachments/object storage, notifications, saved filters, reports, workflow administration, realtime fan-out, import/export, and production OAuth/OIDC remain deliberately deferred until the core transition path is reliable.
