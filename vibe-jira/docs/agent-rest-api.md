# Software-factory agent REST access

This integration lets development agents use Vibe JIRA and OpenRM through their versioned REST APIs. It does not give an agent database access or elevated application privileges: each request is authenticated as a dedicated service user and passes the existing tenant, project-role, capability, workflow, concurrency, and audit checks.

## Trust model

- Create a separate Vibe JIRA user for each agent or agent role. Add that user only to the projects it maintains and prefer `MEMBER` over `ADMIN` unless administration is required.
- Create one expiring Vibe JIRA token per agent. The clear credential is returned once; PostgreSQL stores only its SHA-256 digest and a non-secret display prefix.
- Use an OpenRM OIDC client-credentials identity in production. Its access token must contain the configured issuer/audience, an allowed organization claim, and only the required OpenRM roles. Development may use `dev:<subject>:<role>`.
- Inject credentials through the agent runtime's secret manager. Do not put tokens in prompts, source files, shell history, logs, issue descriptions, or OpenRM connector configuration.
- Use HTTPS outside loopback. The shared client refuses non-loopback plain HTTP, cross-origin paths, redirects, and responses larger than 5 MB.

## Create a Vibe JIRA agent token

Apply migration `0023_agent_api_tokens.sql`, create or activate the service user through normal administration, and grant its project role. Running the lifecycle command is a privileged database/container operation; `--actor` must identify the active user responsible for the audited action. Then create the credential with an active organization administrator as the actor:

```sh
npm run db:migrate
npm run agent-token -- create \
  --user factory-agent@example.com \
  --actor administrator@example.com \
  --name codex-development-agent \
  --expires-in-days 90
```

For the container deployment, the equivalent command is:

```sh
docker compose run --rm app agent-token create \
  --user factory-agent@example.com \
  --actor administrator@example.com \
  --name codex-development-agent \
  --expires-in-days 90
```

If an email exists in more than one organization, also pass `--organization UUID`. Capture the returned `token` immediately in the secret manager. Only the metadata remains listable:

```sh
npm run agent-token -- list \
  --user factory-agent@example.com \
  --actor administrator@example.com
```

Revoke a token by its metadata ID:

```sh
npm run agent-token -- revoke \
  --id 00000000-0000-4000-8000-000000000000 \
  --actor administrator@example.com
```

Creation and first revocation append `agent_token.created` and `agent_token.revoked` audit/outbox evidence. Deactivating the owning user, removing project membership, token expiry, and explicit revocation take effect on subsequent requests.

## Configure the shared REST caller

The repository includes a small caller that applies the correct authentication headers, generates a correlation ID, supplies an idempotency key for `POST`, and emits one JSON response envelope.

```sh
export PROJECTWEAVE_API_BASE_URL=https://jira.example.com
export PROJECTWEAVE_API_TOKEN='load-from-secret-manager'
export OPENRM_API_BASE_URL=https://requirements.example.com
export OPENRM_API_TOKEN='load-from-secret-manager'
export OPENRM_ORGANIZATION_ID=00000000-0000-4000-8000-000000000001
```

For local commissioning, the same variables may be stored in the Git-ignored
`.env.local` file with owner-only permissions (`chmod 600 .env.local`). The
`factory:api` command loads that file automatically; variables already supplied
by the agent runtime or its secret manager take precedence.

Read accessible Jira projects:

```sh
npm run factory:api -- jira GET /api/v1/projects
```

Create a Jira issue idempotently:

```sh
npm run factory:api -- jira POST /api/v1/projects/ENG/issues \
  --idempotency-key agent:openrm:REQ-42:create \
  --data '{"summary":"Implement REQ-42","description":"OpenRM requirement REQ-42","priority":"HIGH","issueType":"TASK","labels":["openrm","REQ-42"]}'
```

Read OpenRM projects:

```sh
npm run factory:api -- openrm GET /api/v1/projects
```

## Synchronize an OpenRM requirement to Jira

The controlled sync command reads the current OpenRM requirement, searches the
target Jira project for its exact requirement-key label, and plans one of
`create`, `update`, or `noop`. It is dry-run by default:

```sh
npm run factory:sync -- \
  --openrm-project 00000000-0000-4000-8000-000000000102 \
  --requirement ORM-011 \
  --jira-project ORM
```

Review the returned plan, then apply it explicitly:

```sh
npm run factory:sync -- \
  --openrm-project 00000000-0000-4000-8000-000000000102 \
  --requirement ORM-011 \
  --jira-project ORM \
  --apply
```

Creation uses a stable idempotency key derived from the OpenRM project and
requirement UUIDs. Updates use the Jira issue version and fail on concurrent
changes. The command owns the issue summary, priority, task type, requirement
and revision labels, and the marked OpenRM block in the description. It
preserves description text outside that block, assignment, parent, estimate,
due date, and unrelated labels. Duplicate requirement labels and malformed
managed blocks stop the operation without writing.

To reconcile every current requirement in a project, use `--all`. The command
pages through OpenRM, enforces a configurable upper bound, and completes the
entire read-only collision/concurrency preflight before its first Jira write:

```sh
# Preview the complete project plan (default maximum: 100 requirements)
npm run factory:sync -- \
  --openrm-project 00000000-0000-4000-8000-000000000102 \
  --all \
  --jira-project ORM

# Apply only after reviewing the create/update/noop summary and plans
npm run factory:sync -- \
  --openrm-project 00000000-0000-4000-8000-000000000102 \
  --all \
  --jira-project ORM \
  --apply
```

Use `--max N` to set an explicit reviewed bound, up to 1,000. Mutations remain
sequential so an audit trail and correlation ID are retained for each issue.

The author-side sync deliberately does not record OpenRM verification results.
OpenRM requires an approved review baseline and an independent project reviewer
to start a verification run and sign its result. Provision a separate reviewer
agent identity and credential for that return path; do not elevate or reuse the
development `factory` identity to bypass segregation of duties.

For larger bodies, use `--data-file PATH` so the JSON remains reviewable. The client never prints configured credentials. It returns the service, HTTP status, success flag, correlation ID, and response body; a non-2xx response also produces a nonzero exit status.

## Agent operating loop

1. Read the controlled requirement and its exact revision from OpenRM.
2. Search Jira for an existing requirement key before creating work. Use a stable idempotency key derived from the OpenRM project, requirement, revision, and intended operation.
3. Put the OpenRM requirement key in a Jira label and the immutable requirement/revision reference in the description or a comment. Never copy secrets or restricted evidence.
4. Perform Jira changes using the returned issue version and allowed transitions; on a conflict, refetch instead of overwriting another actor.
5. Record implementation, review, test, build, and release evidence through the appropriate OpenRM endpoints. Preserve the Jira issue key as the external work reference.
6. Carry the returned correlation ID into agent logs and reports so audit evidence can be joined across the two systems.

The Vibe JIRA contract is [`openapi.json`](./openapi.json). The OpenRM contract is `OpenRM/contracts/openapi.yaml` in the sibling repository.
