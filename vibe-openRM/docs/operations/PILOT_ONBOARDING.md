# Pilot onboarding

## Entry criteria

- Named organization administrator, product owner, reviewer, verification owner, and operator.
- OIDC tenant, pilot project, evidence retention, RPO/RTO, and incident contacts approved.
- Recovery, security, browser, accessibility, and load evidence green for the candidate build.
- Jira service identity restricted to one pilot project.

## Onboarding sequence

1. Create the organization/project and assign least-privilege roles.
2. Import a bounded, non-sensitive requirement set and validate typed attributes.
3. Create trace links, exercise suspect propagation, and freeze a signed baseline.
4. Complete one review and verification package with independent owners.
5. Configure Jira in `dry_run`, inspect payload hashes/attempts, then approve active mode.
6. Export signed gate evidence and confirm recovery from the latest backup.
7. Review dashboards, alerts, escalation paths, and the operator runbook with the pilot team.

## Exit and rollback

The pilot may expand only when there are no launch-blocking security, integrity, accessibility, recovery, or reliability findings. Roll back by disabling active connectors, stopping new writes, exporting current evidence, and following the image/database rollback procedure.
