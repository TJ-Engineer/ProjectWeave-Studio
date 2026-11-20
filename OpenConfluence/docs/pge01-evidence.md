# PGE-01 hierarchy evidence

Status: Complete through GitHub PR #15 (`0c5de14`)

This record maps the completed `PGE-01` evidence gate to repeatable automated
and manual checks. The evidence branch was reviewed and merged through GitHub
PR #15 as `0c5de14`; the completion workflow reconciles `KNW-21` and canonical
story `KNW-12` in Vibe JIRA.

## Automated evidence map

| Behavior                               | Evidence                                                                                                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cycle and cross-space prevention       | `tests/integration/page-hierarchy.integration.test.ts` rejects descendant destinations and foreign spaces with stable errors.                                                                                                    |
| Stale source and destination lists     | The hierarchy suite independently advances each sibling-list version, rejects both stale moves, leaves the page in its source list, and records no failed audit effect.                                                          |
| Competing administrators               | Two administrators reorder the same list concurrently; exactly one commits and the other receives `SIBLING_LIST_VERSION_CONFLICT`.                                                                                               |
| Deterministic rank recovery            | The hierarchy suite exhausts the destination rank interval, rebalances only that list, and retains the source rank.                                                                                                              |
| Durable aliases and lifecycle recovery | `tests/integration/page-lifecycle.integration.test.ts` covers rename aliases, archive, trash, restore, unavailable original parents, surviving-neighbor placement, independent inactive branches, and retained drafts/revisions. |
| Restriction preservation               | Hierarchy and lifecycle fixtures prove that a move or fallback restore cannot broaden inherited access.                                                                                                                          |
| Non-disclosure                         | Navigation and load fixtures prove that tree pages, breadcrumbs, item counts, aliases, published routes, and hidden-parent requests reveal no restricted title or path and use the same `404` as a missing page.                 |
| Bounded scale                          | `tests/load/page-tree.load.test.ts` creates 10,000 published pages with 1,000 direct siblings, enforces the 100-item request ceiling, paginates all 999 viewer-visible siblings, and checks unique cursors.                      |

Run the database gates only against a database whose name ends in `_test`:

```sh
TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5433/knowledge_test npm run test:integration
TEST_DATABASE_URL=postgres://knowledge:knowledge@localhost:5433/knowledge_test npm run test:load
```

`npm run test:load` fails before Vitest starts when `TEST_DATABASE_URL` is
missing or targets a non-test database.

## Load boundary

The load fixture uses real PostgreSQL triggers, sibling-list versions,
immutable revisions, durable aliases, inherited restrictions, and repository
queries. It does not mock authorization or replace the database with an
in-memory projection.

The gate samples both the first and a late cursor page 25 times and requires
each p95 to remain below 500 ms. It also samples an authorized published read
against the same limit, matching the initial M1 API objective. The verified
local PostgreSQL 17 run on 2026-10-18 produced:

| Measurement                        |    Result |
| ---------------------------------- | --------: |
| Fixture pages                      |    10,000 |
| Direct siblings                    |     1,000 |
| Fixture seed                       | 11,525 ms |
| Initial ten-page traversal maximum |   12.4 ms |
| First-page tree p95                |   10.1 ms |
| Late-page tree p95                 |   12.5 ms |
| Published read p95                 |    2.3 ms |

The first attempted gate exposed an N-by-depth recursive authorization plan
with an 11.7-second late-page p95. The regression fix proves the accessible
parent once and evaluates direct child policy set-wise; all existing
authorization integration fixtures still pass against that optimized query.

## Current gate result

- `npm run check` passes formatting, lint, strict types, eleven non-database
  tests, and the production build. The database suites remain deliberately
  skipped in this command and run through their explicit `_test` gates.
- `npm run test:integration` passes eight files and twenty-two tests.
- `npm run test:load` passes one file and two tests with the measurements above.
- No database migration or production dependency was added.

## Browser evidence

- Desktop viewer tree: only the two authorized published roots rendered. Right
  expanded `Getting started`, loaded 50 children, and moved focus to the first;
  Down moved focus to the next item. Load more produced all 52 children and
  removed the pagination control.
- Administrator movement: the labelled non-drag Move up control reordered a
  root and returned focus to its tree item. Editor and viewer surfaces exposed
  no administrator movement or access controls.
- Non-disclosure: restricted published, another principal's private draft,
  restricted edit, and invalid-UUID routes all rendered the same normal 404
  boundary with no private title and no development runtime dialog.
- At 320 CSS pixels, the expanded 54-item tree and published read page had a
  320-pixel scroll width for a 320-pixel viewport. The expand control measured
  40 pixels, pointer activation worked, Enter opened the published page, and
  the viewer received read mode without an Edit link.
- The earlier administrator/editor/viewer matrix remains applicable after the
  query optimization: administrators and editors receive Edit only through
  `page:edit`, while viewers never receive draft content.

GitHub PR #15 records the review and merged implementation. `KNW-21`, canonical
story `KNW-12`, and `PGE-01` advance together because all four bounded
execution issues and the final evidence gate are complete.
