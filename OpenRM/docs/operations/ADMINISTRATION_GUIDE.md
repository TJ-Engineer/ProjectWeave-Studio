# OpenRM administration guide

## Identity and authorization

Production must use `AUTH_MODE=oidc`. Tokens must contain `sub`, `iss`, `aud`, `exp`, an allowed organization identifier, and supported roles. Organization administrators create projects and assign project roles. Authors control requirements and connector delivery requests; reviewers control review/verification actions; viewers are read-only.

Quarterly, administrators must review organization and project memberships, remove dormant identities, validate the OIDC issuer/audience, and record the review in the operating evidence repository.

The pilot loads OIDC signing keys at API startup. Coordinate provider key rotation with a rolling API restart, then verify an authenticated session before removing the prior provider key.

## Jira connector administration

1. Create a least-privilege Jira service identity limited to the pilot project and allowlisted operations.
2. Store its credential in the deployment secret manager and inject it as `JIRA_API_TOKEN`; the connector's fixed reference is `env:JIRA_API_TOKEN`.
3. Configure the project connector in `dry_run` mode and retain the secret reference, field mapping, maximum attempt count, and Jira base URL.
4. Queue representative deliveries and inspect their payload hashes and append-only attempts.
5. Move to `active` only after the dry-run evidence is approved.
6. Investigate every dead letter before replay. Replay is administrator-only and creates an audit event.

OpenRM never stores Jira credential values. Configuration changes use optimistic version checks and retain append-only snapshots.

## Evidence keys

Rotate `EVIDENCE_SIGNING_KEY` under a new `EVIDENCE_SIGNING_KEY_ID`. Existing exports retain their key identifier. Preserve retired keys according to the evidence retention policy so historical signatures remain verifiable.

## Data retention

Audit, revision, baseline, review, verification, connector configuration, and connector attempt evidence is append-only. Set retention at the backup/archive layer; do not delete controlled rows during normal administration.
