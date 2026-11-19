# ProjectWeave Studio

ProjectWeave Studio is a self-hostable software-factory suite maintained in one
Git repository. It contains three independently deployable applications:

| Application    | Path                                   | Responsibility                                                                    |
| -------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| OpenConfluence | [`OpenConfluence/`](./OpenConfluence/) | Team knowledge, spaces, pages, drafts, publication, and content governance        |
| OpenJira       | [`OpenJira/`](./OpenJira/)             | Project, issue, workflow, board, and delivery management                          |
| OpenRM         | [`OpenRM/`](./OpenRM/)                 | Requirements, traceability, controlled change, reviews, and verification evidence |

Each application owns its implementation, documentation, runtime configuration,
database schema, and forward-only migrations. Applications integrate through
authenticated REST APIs and durable events; they do not query one another's
databases.

## Repository layout

```text
ProjectWeave-Studio/
├── OpenConfluence/       # Knowledge workspace
├── OpenJira/             # Delivery and issue management
├── OpenRM/               # Requirements and verification management
├── docs/                 # Suite-level architecture and workflows
├── .github/workflows/    # Monorepo CI entry points
├── .agents/              # Shared agent skills
├── AGENTS.md             # Repository-wide agent guidance
└── GLOSSARY.md           # Shared domain language
```

Application-specific documentation remains with the application:

- [OpenConfluence documentation](./OpenConfluence/docs/)
- [OpenJira documentation](./OpenJira/docs/)
- [OpenRM documentation](./OpenRM/docs/)

## Development

Enter the application directory before installing dependencies or running its
commands. Do not install application dependencies at the repository root.

### OpenConfluence

```sh
cd OpenConfluence
npm install
npm run check
```

See the [OpenConfluence README](./OpenConfluence/README.md) for database,
container, and integration-test setup.

### OpenJira

```sh
cd OpenJira
npm install
npm run check
```

See the [OpenJira README](./OpenJira/README.md) for database, object-storage,
container, browser-test, and software-factory agent setup.

### OpenRM

```sh
cd OpenRM
npm install
npm run check
cargo test --workspace --all-targets
```

See the [OpenRM README](./OpenRM/README.md) for Rust, PostgreSQL, container,
recovery, and deployment setup.

## Software-factory integration

OpenJira provides the bounded REST client used by development agents to call
OpenJira and OpenRM. Configure credentials in the agent runtime's secret
manager or the Git-ignored `OpenJira/.env.local`, then run commands from
`OpenJira/`:

```sh
npm run factory:api -- jira GET /api/v1/projects
npm run factory:api -- openrm GET /api/v1/projects
```

See the [OpenJira agent REST guide](./OpenJira/docs/agent-rest-api.md) and the
[OpenRM agent REST guide](./OpenRM/docs/operations/AGENT_REST_API.md) for the
trust model, token lifecycle, and controlled workflow.

## Data ownership

- OpenConfluence owns its knowledge database and migrations.
- OpenJira owns its issue-management database and migrations.
- OpenRM owns its requirements database and migrations.
- Test databases must be isolated from development and production data.
- Shared database documentation may describe conventions, but shared tables or
  cross-application database access are not permitted.

## Repository rules

- Keep secrets, `.env` files, dependency directories, test output, and generated
  runtime data out of Git.
- Put product-specific code and documentation inside its application directory.
- Put only suite-wide guidance, CI, orchestration, and proven shared assets at
  the repository root.
- Preserve application boundaries when introducing shared libraries; do not
  centralize domain logic or database ownership merely to remove duplication.

See [`AGENTS.md`](./AGENTS.md) for repository-wide development and validation
rules and [`docs/workflows/grill-with-docs.md`](./docs/workflows/grill-with-docs.md)
for the documented requirements-to-delivery workflow.
