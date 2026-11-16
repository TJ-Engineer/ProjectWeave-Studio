# Software-factory agent REST access

OpenRM exposes its controlled workflows through the versioned contract at [`contracts/openapi.yaml`](../../contracts/openapi.yaml). Development agents authenticate with bearer tokens and must also send `X-OpenRM-Organization` on protected requests.

## Authentication

Production agents should use a dedicated OIDC client-credentials identity. The access token must satisfy OpenRM's configured issuer and audience and include the allowed organization plus only the required `administrator`, `author`, `reviewer`, or `viewer` roles. Keep each agent identity separate so audit evidence retains an attributable subject.

Development mode accepts an explicit role-scoped token:

```text
Authorization: Bearer dev:factory-agent:author
X-OpenRM-Organization: 00000000-0000-4000-8000-000000000001
```

Development tokens are rejected in production. Clear credentials belong in the agent runtime's secret manager, never in requirements, evidence, connector rows, source files, or prompts.

## Shared ProjectWeave/OpenRM caller

The companion ProjectWeave checkout provides `vibe-jira/scripts/software-factory-api.ts`, a bounded REST caller for both applications. Configure it without committing credentials:

```sh
export PROJECTWEAVE_API_BASE_URL=https://jira.example.com
export PROJECTWEAVE_API_TOKEN='load-from-secret-manager'
export OPENRM_API_BASE_URL=https://requirements.example.com
export OPENRM_API_TOKEN='load-from-secret-manager'
export OPENRM_ORGANIZATION_ID=00000000-0000-4000-8000-000000000001
```

From `ProjectWeave-Studio/vibe-jira`, an agent can inspect OpenRM projects with:

```sh
npm run factory:api -- openrm GET /api/v1/projects
```

The caller adds the required authentication and organization headers, creates a correlation ID, adds an idempotency key to `POST` requests, rejects unsafe origins and redirects, and never prints configured credentials. Authorization, project isolation, optimistic concurrency, segregation of duties, append-only revision history, and evidence integrity remain enforced by OpenRM.

## Controlled development workflow

1. Read the requirement and exact revision from OpenRM before planning Jira work.
2. Search ProjectWeave Jira for the requirement key and create an issue only when no canonical issue exists.
3. Preserve the OpenRM requirement key/revision and Jira issue key as cross-system references. Do not represent a mutable title as identity.
4. Use stable idempotency keys for retries and current versions for revisions, approvals, and Jira mutations.
5. Write implementation, review, verification, build, and release evidence to the appropriate OpenRM resource. Do not mark a requirement verified solely because a Jira issue is complete.
6. Retain response correlation IDs in agent execution reports so operators can reconcile both applications' audit trails.

## Immutable agent-run provenance

After an execution finishes, an author records one sanitized provenance envelope with `POST /api/v1/projects/{project_id}/agent-runs`. OpenRM binds the authenticated subject, signs the canonical evidence, preserves it with append-only database controls, and links it either to exact OpenRM artifact revisions or external outputs such as Jira issues, commits, and builds.

```sh
npm run factory:api -- openrm POST \
  /api/v1/projects/00000000-0000-4000-8000-000000000102/agent-runs \
  --idempotency-key factory-agent-run-2026-11-14-001 \
  --data '{
    "external_run_id":"codex:orm-005:2026-11-14-001",
    "model":"OpenAI Codex",
    "prompt":"Implement ORM-005 agent-run provenance.",
    "context":{"requirement_key":"ORM-005","jira_issue":"ORM-6"},
    "tool_calls":[{"tool":"openrm.requirements.get","status":"succeeded"}],
    "output":{"summary":"Agent-run provenance API implemented."},
    "outcome":"succeeded",
    "started_at":"2026-11-14T18:00:00Z",
    "completed_at":"2026-11-14T18:15:00Z",
    "outputs":[
      {
        "relation":"updated",
        "artifact_id":"a78184d4-26b3-4383-a193-11a31b2b4e08",
        "artifact_revision_id":"replace-with-exact-revision-uuid"
      },
      {
        "relation":"referenced",
        "external_system":"projectweave-jira",
        "external_reference":"ORM-6"
      }
    ]
  }'
```

Use `GET /api/v1/projects/{project_id}/agent-runs` for bounded history and `GET /api/v1/projects/{project_id}/agent-runs/{agent_run_id}` for a single record. A read recalculates the canonical hash and reports `signature_valid`; consumers must reject evidence when it is false.

The prompt is a sanitized task prompt, not the hidden model instruction stack. Never include bearer tokens, passwords, API keys, cookies, signed URLs, private keys, or raw secret-manager responses. OpenRM rejects common credential-bearing keys in structured context, tool-call, and output data, but callers remain responsible for sanitizing free text.

The Vibe JIRA token lifecycle and command examples are documented in `ProjectWeave-Studio/vibe-jira/docs/agent-rest-api.md` in the companion checkout.
