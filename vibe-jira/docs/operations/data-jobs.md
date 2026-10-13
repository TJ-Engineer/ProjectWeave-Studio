# CSV import and export

Project administrators manage portable issue data at `/projects/{projectKey}/settings/data`. Imports and exports are durable database-backed jobs claimed by the general worker with PostgreSQL row locking. The job list records queued, running, succeeded, or failed state, attempts, timestamps, validation results, and failure messages.

## Import format

Imports accept UTF-8 CSV up to 1 MiB and 1,000 data rows. `Summary` is required. Optional headers are `Description`, `Issue Type`, `Priority`, and `Labels`; header matching ignores case, spaces, hyphens, and underscores. Labels use `|` within a cell. Quoted commas, embedded newlines, and doubled quotes follow RFC 4180 conventions.

Issue type defaults to `TASK`, priority defaults to `MEDIUM`, and supported imported types are Epic, Story, Task, and Bug. Subtasks are rejected because the generic format has no safe parent-key mapping. The dry run reports at most the first 100 field errors without writing data.

Two explicit invalid-row policies are available:

- **Reject the complete file (`ATOMIC`)**: the job is not created unless every row passes validation.
- **Import valid rows only (`SKIP_INVALID`)**: invalid rows are skipped and counted in the job result.

Each enqueue request requires an idempotency key. Repeating the same request returns the original job; reusing its key for different content is rejected. Every created and successful job emits correlated audit and durable outbox evidence.

## Export

Exports include active and soft-deleted issues in issue-key order with key, summary, description, issue type, status, priority, assignee email, labels, created timestamp, and updated timestamp. Downloads are available only after successful completion and require current project-administrator permission. Responses use `text/csv`, attachment disposition, UTF-8, and content-sniffing protection.

## Recovery

Check the job's failure message first, then verify the project is active and the initiating user remains active with project-administrator access. A failed job is immutable evidence; correct the cause and enqueue a new request with a new idempotency key. The worker and queue are monitored through `/administration/outbox`.
