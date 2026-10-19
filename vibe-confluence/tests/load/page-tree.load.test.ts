import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pageTreeQuerySchema, type UserIdentity } from "@knowledge/contracts";
import {
  closePool,
  createPage,
  createSpace,
  getPageWorkspace,
  getPool,
  getPublishedPage,
  listPageTree,
  publishPage,
  resolvePageAlias,
  updatePageRestriction,
  upsertSpaceMember,
} from "@knowledge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (
  testDatabaseUrl &&
  !new URL(testDatabaseUrl).pathname.slice(1).endsWith("_test")
) {
  throw new Error("Load tests require a database name ending in _test");
}
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl;

const organizationId = randomUUID();

function identity(
  displayName: string,
  organizationRole: "ADMIN" | "MEMBER" = "MEMBER",
): UserIdentity {
  const id = randomUUID();
  return {
    id,
    organizationId,
    email: `${id}@example.test`,
    displayName,
    organizationRole,
  };
}

function percentile95(samples: number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

const organizationAdmin = identity("Scale Organization Admin", "ADMIN");
const allowedViewer = identity("Scale Allowed Viewer");
const deniedViewer = identity("Scale Denied Viewer");
const identities = [organizationAdmin, allowedViewer, deniedViewer];

let spaceId = "";
let spaceKey = "";
let rootId = "";
let hiddenChildId = "";
let hiddenLeafId = "";
let visibleChildId = "";
let seedDurationMs = 0;
let initialPaginationMaxMs = 0;
let latePageCursor = "";

async function publishFreshPage(actor: UserIdentity, pageId: string) {
  const workspace = await getPageWorkspace(actor, pageId);
  return publishPage(
    actor,
    pageId,
    {
      title: workspace.draft.title,
      document: workspace.draft.document,
      baseRevisionId: workspace.draft.baseRevisionId,
      version: workspace.draft.version,
      summary: "KNW-21 scale fixture",
    },
    `publish-${randomUUID()}`,
    randomUUID(),
  );
}

describe.skipIf(!testDatabaseUrl)("PGE-01 hierarchy scale", () => {
  beforeAll(async () => {
    const seedStarted = performance.now();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'KNW-21 Scale Test', $2)`,
      [organizationId, `knw21-scale-${organizationId}`],
    );
    for (const user of identities) {
      await getPool().query(
        `INSERT INTO users
          (id, organization_id, email, display_name, password_hash)
         VALUES ($1, $2, $3, $4, 'unused')`,
        [user.id, organizationId, user.email, user.displayName],
      );
      await getPool().query(
        `INSERT INTO memberships
          (organization_id, user_id, organization_role)
         VALUES ($1, $2, $3)`,
        [organizationId, user.id, user.organizationRole],
      );
    }

    const space = await createSpace(
      organizationAdmin,
      {
        key: "SCALE10K",
        name: "Ten-thousand page scale fixture",
        description: "KNW-21 bounded hierarchy evidence",
      },
      randomUUID(),
    );
    spaceId = space.id;
    spaceKey = space.key;
    let membershipVersion = 1;
    for (const viewer of [allowedViewer, deniedViewer]) {
      const membership = await upsertSpaceMember(
        organizationAdmin,
        spaceKey,
        viewer.id,
        { role: "VIEWER", expectedMembershipVersion: membershipVersion },
        randomUUID(),
      );
      membershipVersion = membership.membershipVersion;
    }

    rootId = (
      await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Scale root", parentId: null },
        randomUUID(),
      )
    ).id;
    await publishFreshPage(organizationAdmin, rootId);

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO pages
          (id, organization_id, space_id, parent_id, current_revision_id,
           title, slug, sibling_rank, state, version, created_by)
         SELECT gen_random_uuid(), $1, $2, $3, NULL,
                'Scale child ' || lpad(sequence::text, 4, '0'),
                'scale-child-' || lpad(sequence::text, 4, '0'),
                sequence * 1024, 'ACTIVE', 1, $4
           FROM generate_series(1, 1000) AS sequence`,
        [organizationId, spaceId, rootId, organizationAdmin.id],
      );
      await client.query(
        `WITH direct_children AS (
           SELECT id,
                  row_number() OVER (ORDER BY sibling_rank, id) AS ordinal
             FROM pages
            WHERE organization_id = $1 AND space_id = $2 AND parent_id = $3
         )
         INSERT INTO pages
          (id, organization_id, space_id, parent_id, current_revision_id,
           title, slug, sibling_rank, state, version, created_by)
         SELECT gen_random_uuid(), $1, $2, direct_child.id, NULL,
                'Scale leaf ' || lpad(sequence::text, 5, '0'),
                'scale-leaf-' || lpad(sequence::text, 5, '0'),
                (((sequence - 1) / 1000) + 1) * 1024,
                'ACTIVE', 1, $4
           FROM generate_series(1, 8999) AS sequence
           JOIN direct_children direct_child
             ON direct_child.ordinal = ((sequence - 1) % 1000) + 1`,
        [organizationId, spaceId, rootId, organizationAdmin.id],
      );
      await client.query(
        `WITH new_revisions AS (
           INSERT INTO page_revisions
            (id, organization_id, page_id, number, author_id, title,
             body_json, body_text, schema_version, summary,
             idempotency_key, request_hash)
           SELECT gen_random_uuid(), page.organization_id, page.id, 1, $3,
                  page.title,
                  '{"type":"doc","schemaVersion":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Scale fixture"}]}]}'::jsonb,
                  'Scale fixture', 1, 'KNW-21 scale fixture',
                  'scale-' || page.id::text, md5(page.id::text)
             FROM pages page
            WHERE page.organization_id = $1 AND page.space_id = $2
              AND page.current_revision_id IS NULL
           RETURNING id, page_id
         )
         UPDATE pages page
            SET current_revision_id = revision.id,
                version = page.version + 1,
                updated_at = now()
           FROM new_revisions revision
          WHERE page.organization_id = $1 AND page.id = revision.page_id`,
        [organizationId, spaceId, organizationAdmin.id],
      );
      await client.query(
        `INSERT INTO page_aliases
          (organization_id, space_id, page_id, slug)
         SELECT page.organization_id, page.space_id, page.id, page.slug
           FROM pages page
          WHERE page.organization_id = $1 AND page.space_id = $2
         ON CONFLICT (space_id, slug) DO NOTHING`,
        [organizationId, spaceId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const selected = await getPool().query<{
      hidden_child_id: string;
      hidden_leaf_id: string;
      visible_child_id: string;
    }>(
      `SELECT
         (SELECT id FROM pages WHERE organization_id = $1 AND space_id = $2
           AND slug = 'scale-child-0500') AS hidden_child_id,
         (SELECT id FROM pages WHERE organization_id = $1 AND space_id = $2
           AND parent_id = (SELECT id FROM pages
             WHERE organization_id = $1 AND space_id = $2
               AND slug = 'scale-child-0500')
           ORDER BY sibling_rank, id LIMIT 1) AS hidden_leaf_id,
         (SELECT id FROM pages WHERE organization_id = $1 AND space_id = $2
           AND slug = 'scale-child-0001') AS visible_child_id`,
      [organizationId, spaceId],
    );
    hiddenChildId = selected.rows[0]!.hidden_child_id;
    hiddenLeafId = selected.rows[0]!.hidden_leaf_id;
    visibleChildId = selected.rows[0]!.visible_child_id;
    await updatePageRestriction(
      organizationAdmin,
      hiddenChildId,
      {
        restricted: true,
        memberIds: [allowedViewer.id],
        expectedVersion: 0,
      },
      randomUUID(),
    );
    await getPool().query(
      "ANALYZE pages, page_restrictions, page_restriction_members",
    );
    seedDurationMs = performance.now() - seedStarted;
  }, 120_000);

  afterAll(closePool);

  it("keeps 10,000 pages and 1,000 siblings bounded and non-disclosing", async () => {
    const inventory = await getPool().query<{
      direct_children: string;
      page_count: string;
    }>(
      `SELECT
         count(*)::text AS page_count,
         count(*) FILTER (WHERE parent_id = $3)::text AS direct_children
       FROM pages
       WHERE organization_id = $1 AND space_id = $2`,
      [organizationId, spaceId, rootId],
    );
    expect(inventory.rows[0]).toEqual({
      page_count: "10000",
      direct_children: "1000",
    });
    expect(
      pageTreeQuerySchema.safeParse({
        parentId: rootId,
        cursor: null,
        limit: 101,
      }).success,
    ).toBe(false);

    const visibleIds: string[] = [];
    const pageDurations: number[] = [];
    let cursor: string | null = null;
    do {
      const started = performance.now();
      const page = await listPageTree(deniedViewer, spaceKey, {
        parentId: rootId,
        cursor,
        limit: 100,
      });
      pageDurations.push(performance.now() - started);
      expect(page.items.length).toBeLessThanOrEqual(100);
      expect(page.breadcrumbs.map((breadcrumb) => breadcrumb.id)).toEqual([
        rootId,
      ]);
      expect(JSON.stringify(page)).not.toContain("Scale child 0500");
      visibleIds.push(...page.items.map((item) => item.id));
      if (visibleIds.length === 800) latePageCursor = page.nextCursor ?? "";
      cursor = page.nextCursor;
    } while (cursor);

    expect(visibleIds).toHaveLength(999);
    expect(new Set(visibleIds).size).toBe(999);
    expect(visibleIds).not.toContain(hiddenChildId);

    const hiddenError = await getPublishedPage(
      deniedViewer,
      hiddenChildId,
    ).catch((error: unknown) => error);
    const missingError = await getPublishedPage(
      deniedViewer,
      randomUUID(),
    ).catch((error: unknown) => error);
    expect(hiddenError).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(missingError).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(String(hiddenError)).toBe(String(missingError));
    await expect(
      getPublishedPage(deniedViewer, hiddenLeafId),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      resolvePageAlias(deniedViewer, spaceKey, "scale-child-0500"),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      listPageTree(deniedViewer, spaceKey, {
        parentId: hiddenChildId,
        cursor: null,
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    initialPaginationMaxMs = Math.max(...pageDurations);
    expect(latePageCursor).not.toBe("");
  }, 120_000);

  it("keeps repeated bounded tree and published-page reads within the M1 objective", async () => {
    const firstPageDurations: number[] = [];
    const latePageDurations: number[] = [];
    const readDurations: number[] = [];
    for (let iteration = 0; iteration < 25; iteration += 1) {
      let started = performance.now();
      const firstPage = await listPageTree(deniedViewer, spaceKey, {
        parentId: rootId,
        cursor: null,
        limit: 100,
      });
      firstPageDurations.push(performance.now() - started);
      expect(firstPage.items).toHaveLength(100);

      started = performance.now();
      const latePage = await listPageTree(deniedViewer, spaceKey, {
        parentId: rootId,
        cursor: latePageCursor,
        limit: 100,
      });
      latePageDurations.push(performance.now() - started);
      expect(latePage.items.length).toBeGreaterThan(0);
      expect(latePage.items.length).toBeLessThanOrEqual(100);

      started = performance.now();
      await getPublishedPage(deniedViewer, visibleChildId);
      readDurations.push(performance.now() - started);
    }

    const firstPageP95Ms = percentile95(firstPageDurations);
    const latePageP95Ms = percentile95(latePageDurations);
    const publishedReadP95Ms = percentile95(readDurations);
    process.stdout.write(
      `\nKNW-21 load evidence: ${JSON.stringify({
        pages: 10_000,
        directSiblings: 1_000,
        samples: 25,
        seedDurationMs: Number(seedDurationMs.toFixed(1)),
        initialPaginationMaxMs: Number(initialPaginationMaxMs.toFixed(1)),
        firstPageP95Ms: Number(firstPageP95Ms.toFixed(1)),
        latePageP95Ms: Number(latePageP95Ms.toFixed(1)),
        publishedReadP95Ms: Number(publishedReadP95Ms.toFixed(1)),
      })}\n`,
    );
    expect(firstPageP95Ms).toBeLessThan(500);
    expect(latePageP95Ms).toBeLessThan(500);
    expect(publishedReadP95Ms).toBeLessThan(500);
  }, 120_000);
});
