# Kanban metric definitions

Vibe JIRA calculates Release 1 flow metrics from immutable issue creation and status-transition events. Status category snapshots (`TODO`, `IN_PROGRESS`, and `DONE`) are written into every new event so later workflow renaming does not reinterpret history. Migration `0018_reporting_snapshots.sql` backfills snapshots where the referenced statuses still exist.

All date buckets use UTC. A selected start date begins at `00:00:00.000Z`; an end date includes the complete UTC day and is capped at the current instant. Report windows span at most 367 days. Reorders, field edits, comments, deletion, and restoration do not change flow state.

## Definitions

- **Lead time**: elapsed wall-clock seconds from issue creation to the first transition into a `DONE` status. Reopening does not move the first completion boundary.
- **Cycle time**: elapsed wall-clock seconds from the first transition into `IN_PROGRESS` to the first later transition into `DONE`. Time spent after work first starts—including a return to `TODO`—remains part of cycle time.
- **Throughput**: count of issues whose first `DONE` entry falls inside the selected period, bucketed by that event's UTC date.
- **Aging WIP**: for an issue currently in `IN_PROGRESS`, elapsed seconds since its most recent entry into `IN_PROGRESS`. TODO and DONE issues are excluded.
- **Status-category time**: elapsed wall-clock time assigned to each category between creation, transition events, and the report's as-of instant. The report presents the average per included issue.
- **Cumulative flow**: end-of-UTC-day issue counts by category. The current day's point uses the current instant.
- **Created versus resolved**: creations by issue creation date versus first-DONE completions by date.

Durations are not business-calendar adjusted. Deleted issues remain in historical flow counts because deletion does not erase work or its events. Issues with no first-DONE event have no lead/cycle time and do not contribute to throughput. Issues that reach DONE without an IN_PROGRESS event have lead time but no cycle time.

The deterministic unit fixtures cover reopening, multiple in-progress entries, first-completion boundaries, category duration, and current WIP aging. PostgreSQL acceptance fixtures verify that API aggregates reproduce known event timestamps.
