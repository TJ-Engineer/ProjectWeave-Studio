# ProjectWeave — instructions for agents

ProjectWeave is a self-hostable project and issue management application with a Kanban-first workflow.

## Start every session here

1. Read `vibe-jira/DEVELOPMENT_STORYBOARD.md` for current status, upcoming work, release gates, and known risks.
2. Read the relevant section of `vibe-jira/IMPLEMENTATION_PLAN.md` before changing product behavior or architecture.
3. Use `vibe-jira/README.md` and the documentation under `vibe-jira/docs/` for setup, operations, security, accessibility, and API details.
4. Inspect the existing implementation and tests before making changes. Preserve established patterns unless the task requires changing them.

## Source of truth

- `vibe-jira/` is the active application.
- The repository-level `backend/` and `frontend/` directories are disposable prototypes and are not dependencies of the active application.
- Keep implementation status and planning documents accurate when work changes their claims.
- Do not claim that a release gate is complete without corresponding automated or documented manual evidence.

## Architecture and implementation

- Use TypeScript in strict mode for application code.
- Keep shared contracts and domain rules in the appropriate workspace package instead of duplicating them in UI and route handlers.
- Validate all untrusted input at runtime; TypeScript types are not runtime validation.
- Enforce authorization, tenant scope, workflow rules, and data integrity on the server. Hiding a UI control is not authorization.
- Keep database changes explicit and forward-only through numbered SQL migrations.
- Preserve optimistic-concurrency, idempotency, audit, history, and outbox behavior on mutation paths that already support them.
- Keep attachments outside the database and permission-check access before issuing download URLs.
- Avoid adding a new service or dependency when the existing architecture can solve the problem cleanly.

## Reliability and security

- Handle expected failures explicitly and return stable, useful errors.
- Never expose credentials, session secrets, invitation tokens, signed URLs, or sensitive user data in logs or committed files.
- Do not trust client-supplied roles, organization IDs, project IDs, ranks, workflow state, or ownership claims.
- Keep multi-step writes atomic when partial completion would corrupt state or lose audit evidence.
- Preserve last-administrator, active-assignment, hierarchy, and cross-project safeguards.
- Add a regression test for every bug fix when practical.

## User experience

- Maintain keyboard, pointer, and touch support for primary workflows.
- Preserve accessible names, focus behavior, semantic structure, and non-drag alternatives for board movement.
- Keep large collections paginated or bounded; do not render unbounded issue sets in the browser.
- Sanitize user-authored content before rendering it.
- Follow the existing design system and interaction patterns.

## Assets and third-party material

- Add only original assets or assets whose licenses permit use and redistribution in this repository.
- Do not copy another product's proprietary icons, artwork, themes, templates, screenshots, or distinctive interface styling.
- Record required attribution and license information when adding third-party material.

## Validation

Run the checks relevant to the change from `vibe-jira/`. The full application gate is:

```sh
npm run check
```

Additional checks include:

```sh
npm run test:integration
npm run test:e2e
npm run test:load
docker compose --profile test run --rm test
infra/operations/recovery-drill.sh
```

- Use the smallest relevant check while iterating, then run the broader gate appropriate to the risk of the change.
- Integration tests must run only against a database whose name ends in `_test`.
- For UI changes, inspect the rendered result at desktop and responsive widths and exercise keyboard interaction.
- Do not weaken or remove tests merely to make a change pass.

## Documentation

- Update API documentation and regenerate `docs/openapi.json` when endpoint contracts change.
- Update operator or user documentation when setup, configuration, permissions, workflows, or recovery behavior changes.
- Record consequential architectural decisions under `vibe-jira/docs/decisions/`.
- Keep `vibe-jira/DEVELOPMENT_STORYBOARD.md` aligned with the implementation and verified evidence.

## Working practices

- Keep changes focused on the requested task and preserve unrelated user work.
- Never commit secrets, local environment files, generated runtime data, or dependency directories.
- Prefer non-destructive commands and inspect targets before deleting or overwriting files.
- Do not create commits unless the user asks for one.
