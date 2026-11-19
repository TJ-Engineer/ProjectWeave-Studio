# Administrator guide

Organization administrators can reach administration from the Projects page.

## Onboard and control access

- Create a one-time invitation in **Administration → Settings** and transmit the activation link through an approved channel. It expires after 72 hours and cannot be reused.
- Change organization role or account state from the same page. Deactivated users cannot authenticate, while their historical attribution remains intact.
- Create organization teams in **Administration → Teams**, select active members, and save. A project administrator grants that team a Viewer, Member, or Administrator role from **Board → Team access**.
- Direct and team roles are additive; the strongest role is effective. Removing a team grant takes effect on the next request.

## Operate projects

- Create projects with either the five-status delivery template or the simple template.
- Use **Project settings** to manage direct members, team access, WIP limits, board name, and the workflow graph.
- Used statuses can be removed only with an explicit destination status. The migration is atomic and records issue history.
- Archived projects disappear from normal project, board, search, and report surfaces without deleting data.

## Audit, jobs, and health

- **Administration → Audit** filters immutable evidence by actor, action, target, correlation ID, and date. Retention is configurable from 30 to 3,650 days.
- **Administration → Outbox** shows queue age, delivery totals, worker heartbeat, and dead letters. Retry only after correcting the underlying cause.
- Project data settings provide CSV dry runs, bounded imports, exports, job status, and protected downloads.
- `/health/live` reports process/build identity; `/health/ready` tests the database; `/health/metrics` exposes Prometheus text and can require `METRICS_TOKEN`.

Backup, restore, upgrade, rollback, and incident procedures are in the [operator runbook](./operations/runbook.md).
