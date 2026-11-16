# OpenRM deployment guide

This guide describes the supported pilot deployment shape. The repository does not claim a live production environment until an operator records environment-specific evidence.

## Portable all-in-one stack

The repository-root `compose.yaml` is the portable evaluation and development distribution. A host needs only Docker Engine with Compose v2:

```bash
docker compose up --build -d
curl --fail http://127.0.0.1:8080/ready
```

The single command builds and starts:

- PostgreSQL 17 with a named persistent volume and loopback-only development port;
- a pinned LocalStack S3 service with a persistent volume, an automatically initialized versioned bucket, and a loopback-only development port;
- a one-shot, forward-only database migration container;
- the non-root Rust API with a read-only root filesystem and health check;
- a one-shot non-root bootstrap container that creates or verifies the 60-requirement `OPENRM` project;
- the non-root Nginx web image with a read-only root filesystem, SPA fallback, security headers, and same-origin API proxy.

The browser entry point is `http://127.0.0.1:8080`. The API is intentionally not published as a separate host port; `/api`, `/health`, and `/ready` pass through the web gateway. Change `OPENRM_PORT` to avoid a port conflict, or set `OPENRM_BIND_ADDRESS=0.0.0.0` for an intentionally network-accessible host. The latter requires appropriate host firewall and network controls.

### Local-first regression loop

Use the persistent local stack for routine feature work and regression testing:

```bash
npm run regress:local
```

This command rebuilds with Docker's layer cache, starts or updates the persistent Compose stack, checks the real web/API/PostgreSQL path and authentication boundary, runs a read-only Chromium smoke journey against the clean container, and then runs the full mocked Chromium UI regression suite. The container browser targets the clean `OpenRM` workspace with the `ORM` requirement prefix, development authentication, and fail-closed API behavior with no fabricated fallback. The command deliberately leaves the stack running at `http://127.0.0.1:8080` for interactive testing. Use `npm run check:local` to repeat only the fast runtime checks, and `npm run local:down` when the persistent environment is no longer needed.

Routine development iterations stop at this local gate. Run the isolated `npm run check:containers` clean-room reconstruction plus the full repository and three-browser gates only when preparing a release candidate. Promote immutable images to AWS only after those release-candidate gates pass.

Portable-stack settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENRM_BIND_ADDRESS` | `127.0.0.1` | Web gateway host bind address. |
| `OPENRM_PORT` | `8080` | Web gateway host port. |
| `OPENRM_POSTGRES_BIND_ADDRESS` | `127.0.0.1` | Native-development PostgreSQL bind address. |
| `OPENRM_POSTGRES_PORT` | `5432` | Native-development PostgreSQL host port. |
| `OPENRM_POSTGRES_DB` | `openrm` | Database name. |
| `OPENRM_POSTGRES_USER` | `openrm` | Database role. |
| `OPENRM_POSTGRES_PASSWORD` | `openrm` | Development database password; replace outside local evaluation. |
| `OPENRM_OBJECT_STORAGE_BIND_ADDRESS` | `127.0.0.1` | Local S3-compatible API bind address. |
| `OPENRM_OBJECT_STORAGE_PORT` | `4566` | Local S3-compatible API port. |
| `OPENRM_OBJECT_STORAGE_BUCKET` | `openrm-controlled-objects` | Project object bucket used by the storage adapter. |
| `OPENRM_OBJECT_STORAGE_REGION` | `us-east-2` | Selected Region used for object-storage signing. |
| `OPENRM_EVIDENCE_SIGNING_KEY` | Development-only value | Evidence-signing material. |
| `OPENRM_EVIDENCE_SIGNING_KEY_ID` | `portable-development` | Evidence-signing key identifier. |
| `OPENRM_EVIDENCE_VERIFICATION_KEYS` | Empty | JSON object mapping historical key identifiers to keys during rotation. |
| `OPENRM_EVIDENCE_REF` | `main` | Repository ref attached to self-verification evidence. |
| `OPENRM_SELF_EVIDENCE_RUN_URL` | Container marker | Evidence execution link or marker. |
| `OPENRM_RUST_LOG` | API and HTTP info | Rust log filter. |

Passwords containing URL-reserved characters must be percent-encoded for the API connection string. For non-development deployment, use the hardened production topology and an operator-managed secret mechanism.

Preserve the evidence-signing key with the database. During an intentional rotation, set a new active key and identifier and supply earlier keys through `OPENRM_EVIDENCE_VERIFICATION_KEYS`, for example `{"previous-key-id":"previous-key-material"}`. OpenRM selects verification material by the immutable `signing_key_id` stored with each evidence record; unknown identifiers fail closed.

Verify a completely fresh, isolated container deployment with:

```bash
npm run check:containers
```

The smoke script uses a dedicated Compose project and volumes, verifies web/API/object-storage readiness, confirms the `OPENRM` project has all 60 requirements, checks non-root/read-only execution, and then removes only its isolated test resources.

## Required services

- OpenRM API image built from `deploy/openrm-api.Dockerfile`.
- PostgreSQL 17 with encrypted durable storage and point-in-time recovery configured by the operator.
- An OIDC provider that publishes discovery metadata and RSA signing keys.
- An OpenTelemetry Collector reachable over OTLP/HTTP.
- Prometheus or another scraper for `/metrics`.
- The existing static web deployment, configured with the API base URL and OIDC client.

## Secrets

Inject these through the deployment platform's secret manager; never commit them or place them in connector configuration rows:

- `OPENRM_DATABASE_URL`
- `OPENRM_EVIDENCE_SIGNING_KEY` (at least 32 bytes in production)
- `OPENRM_EVIDENCE_SIGNING_KEY_ID`
- `OPENRM_EVIDENCE_VERIFICATION_KEYS` when historical evidence keys must remain valid after rotation
- `OPENRM_JIRA_API_TOKEN` when active Jira delivery is enabled
- the file referenced by `OPENRM_POSTGRES_PASSWORD_FILE`

The non-secret connector reference is fixed to `env:JIRA_API_TOKEN`; the deployment platform decides which operator-managed secret supplies that environment variable.

## First deployment

1. Copy `deploy/compose.production.yaml` and the `deploy/observability` directory to the deployment host.
2. Set the required `OPENRM_*` environment variables.
3. Build the immutable image: `docker compose -f deploy/compose.production.yaml build api`.
4. Run migrations as a one-off task using the same image and production secret set: `docker compose -f deploy/compose.production.yaml run --rm --entrypoint /usr/local/bin/openrm-migrate api`.
5. Start the services: `docker compose -f deploy/compose.production.yaml up -d`.
6. Verify `/health`, `/ready`, `/metrics`, OIDC authentication, and `/api/v1/operations/status`.
7. Run the security and load smoke matrices before admitting pilot data.

The bundled collector writes trace summaries to its debug exporter so the OTLP path is observable during pilot commissioning. Replace or augment that exporter with the operator's retained trace backend before relying on traces for incident retention.

The API container runs as UID 10001, has no Linux capabilities, uses a read-only root filesystem, and accepts production startup only with OIDC and an explicit evidence-signing key.
Keep `/metrics` on the private service network and route only intended API paths through the public ingress; the bundled Compose file binds operator-facing ports to loopback.

## Rollback

Application rollback is image-based. Retain the prior image digest, stop writes, restore the last compatible database snapshot if a migration is not backward compatible, deploy the prior digest, and execute the validation steps in the operator runbook. Never attempt to reverse append-only evidence with ad hoc SQL.
