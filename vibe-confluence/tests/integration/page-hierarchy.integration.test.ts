import { randomUUID } from "node:crypto";
import { type UserIdentity } from "@knowledge/contracts";
import {
  closePool,
  createPage,
  createSpace,
  getPageRestrictionAdministration,
  getPageWorkspace,
  getPool,
  listPages,
  listPageTree,
  movePage,
  publishPage,
  updatePageRestriction,
  upsertSpaceMember,
} from "@knowledge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (
  testDatabaseUrl &&
  !new URL(testDatabaseUrl).pathname.slice(1).endsWith("_test")
) {
  throw new Error("Integration tests require a database name ending in _test");
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

const organizationAdmin = identity("Hierarchy Organization Admin", "ADMIN");
const spaceAdmin = identity("Hierarchy Space Admin");
const editor = identity("Hierarchy Editor");
const allowedViewer = identity("Hierarchy Allowed Viewer");
const deniedViewer = identity("Hierarchy Denied Viewer");
const identities = [
  organizationAdmin,
  spaceAdmin,
  editor,
  allowedViewer,
  deniedViewer,
];

let spaceKey = "";
let sourceParentId = "";
let destinationParentId = "";
let movablePageId = "";
let descendantPageId = "";

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
      summary: "KNW-18 hierarchy fixture",
    },
    `publish-${randomUUID()}`,
    randomUUID(),
  );
}

describe.skipIf(!testDatabaseUrl)("versioned page hierarchy", () => {
  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'KNW-18 Hierarchy Test', $2)`,
      [organizationId, `knw18-hierarchy-${organizationId}`],
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
        key: "HIERARCHY",
        name: "Versioned hierarchy",
        description: "KNW-18 movement and ordering evidence",
      },
      randomUUID(),
    );
    spaceKey = space.key;
    let membershipVersion = 1;
    for (const [user, role] of [
      [spaceAdmin, "ADMIN"],
      [editor, "EDITOR"],
      [allowedViewer, "VIEWER"],
      [deniedViewer, "VIEWER"],
    ] as const) {
      const result = await upsertSpaceMember(
        organizationAdmin,
        spaceKey,
        user.id,
        { role, expectedMembershipVersion: membershipVersion },
        randomUUID(),
      );
      membershipVersion = result.membershipVersion;
    }

    sourceParentId = (
      await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Restricted source", parentId: null },
        randomUUID(),
      )
    ).id;
    destinationParentId = (
      await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Open destination", parentId: null },
        randomUUID(),
      )
    ).id;
    movablePageId = (
      await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Movable subtree", parentId: sourceParentId },
        randomUUID(),
      )
    ).id;
    descendantPageId = (
      await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Nested descendant", parentId: movablePageId },
        randomUUID(),
      )
    ).id;

    for (const pageId of [
      sourceParentId,
      destinationParentId,
      movablePageId,
      descendantPageId,
    ]) {
      await publishFreshPage(organizationAdmin, pageId);
    }
    await updatePageRestriction(
      organizationAdmin,
      sourceParentId,
      {
        restricted: true,
        memberIds: [allowedViewer.id],
        expectedVersion: 0,
      },
      randomUUID(),
    );
  });

  afterAll(closePool);

  it("moves a subtree atomically without broadening inherited access", async () => {
    const source = await listPageTree(organizationAdmin, spaceKey, {
      parentId: sourceParentId,
      cursor: null,
      limit: 100,
    });
    const destination = await listPageTree(organizationAdmin, spaceKey, {
      parentId: destinationParentId,
      cursor: null,
      limit: 100,
    });

    const moved = await movePage(
      organizationAdmin,
      movablePageId,
      {
        destinationParentId,
        beforePageId: null,
        afterPageId: null,
        expectedSourceVersion: source.parentVersion,
        expectedDestinationVersion: destination.parentVersion,
      },
      "move-preserving-access",
    );
    expect(moved).toMatchObject({
      sourceParentId,
      destinationParentId,
      sourceVersion: source.parentVersion + 1,
      destinationVersion: destination.parentVersion + 1,
      restrictionMaterialized: true,
      page: { id: movablePageId, parentId: destinationParentId },
    });

    const destinationAfter = await listPageTree(organizationAdmin, spaceKey, {
      parentId: destinationParentId,
      cursor: null,
      limit: 100,
    });
    expect(destinationAfter.items.map((page) => page.id)).toEqual([
      movablePageId,
    ]);
    const descendantTree = await listPageTree(organizationAdmin, spaceKey, {
      parentId: movablePageId,
      cursor: null,
      limit: 100,
    });
    expect(descendantTree.breadcrumbs.map((page) => page.id)).toEqual([
      destinationParentId,
      movablePageId,
    ]);
    expect(descendantTree.items).toEqual([
      expect.objectContaining({ id: descendantPageId, hasChildren: false }),
    ]);

    const restriction = await getPageRestrictionAdministration(
      organizationAdmin,
      movablePageId,
    );
    expect(restriction).toMatchObject({ restricted: true, version: 1 });
    expect(restriction.memberIds).toEqual(
      [organizationAdmin.id, spaceAdmin.id, allowedViewer.id].sort(),
    );
    expect(
      (await listPages(allowedViewer, spaceKey)).pages.map((page) => page.id),
    ).toEqual(expect.arrayContaining([movablePageId, descendantPageId]));
    const deniedPageIds = (await listPages(deniedViewer, spaceKey)).pages.map(
      (page) => page.id,
    );
    expect(deniedPageIds).not.toContain(movablePageId);
    expect(deniedPageIds).not.toContain(descendantPageId);

    const effects = await getPool().query<{
      audit_count: string;
      outbox_count: string;
      safe_metadata: Record<string, unknown>;
    }>(
      `SELECT
         count(*) FILTER (WHERE source = 'audit')::text AS audit_count,
         count(*) FILTER (WHERE source = 'outbox')::text AS outbox_count,
         max(metadata::text)::jsonb AS safe_metadata
       FROM (
         SELECT 'audit' AS source, safe_metadata AS metadata
           FROM audit_events
          WHERE organization_id = $1 AND correlation_id = $2
         UNION ALL
         SELECT 'outbox' AS source, payload AS metadata
           FROM outbox_events
          WHERE organization_id = $1 AND topic = 'page.moved'
            AND aggregate_id = $3
       ) evidence`,
      [organizationId, "move-preserving-access", movablePageId],
    );
    expect(effects.rows[0]).toMatchObject({
      audit_count: "1",
      outbox_count: "1",
      safe_metadata: {
        sourceParentId,
        destinationParentId,
        restrictionMaterialized: true,
      },
    });

    const narrowingPage = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Narrowed by destination", parentId: null },
      randomUUID(),
    );
    await publishFreshPage(organizationAdmin, narrowingPage.id);
    expect(
      (await listPages(deniedViewer, spaceKey)).pages.map((page) => page.id),
    ).toContain(narrowingPage.id);
    const rootBeforeNarrowing = await listPageTree(
      organizationAdmin,
      spaceKey,
      { parentId: null, cursor: null, limit: 100 },
    );
    const restrictedDestination = await listPageTree(
      organizationAdmin,
      spaceKey,
      { parentId: sourceParentId, cursor: null, limit: 100 },
    );
    await expect(
      movePage(
        organizationAdmin,
        narrowingPage.id,
        {
          destinationParentId: sourceParentId,
          beforePageId: null,
          afterPageId: null,
          expectedSourceVersion: rootBeforeNarrowing.parentVersion,
          expectedDestinationVersion: restrictedDestination.parentVersion,
        },
        "move-narrowing-access",
      ),
    ).resolves.toMatchObject({ restrictionMaterialized: false });
    await expect(
      getPageRestrictionAdministration(organizationAdmin, narrowingPage.id),
    ).resolves.toMatchObject({ restricted: false, version: 0 });
    expect(
      (await listPages(deniedViewer, spaceKey)).pages.map((page) => page.id),
    ).not.toContain(narrowingPage.id);
  });

  it("rejects cycles, editor movement, and stale sibling versions", async () => {
    const root = await listPageTree(organizationAdmin, spaceKey, {
      parentId: null,
      cursor: null,
      limit: 100,
    });
    const descendant = await listPageTree(organizationAdmin, spaceKey, {
      parentId: descendantPageId,
      cursor: null,
      limit: 100,
    });
    await expect(
      movePage(
        organizationAdmin,
        destinationParentId,
        {
          destinationParentId: descendantPageId,
          beforePageId: null,
          afterPageId: null,
          expectedSourceVersion: root.parentVersion,
          expectedDestinationVersion: descendant.parentVersion,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "PAGE_CYCLE", status: 409 });

    const otherSpace = await createSpace(
      organizationAdmin,
      {
        key: "OTHERSPACE",
        name: "Other hierarchy space",
        description: "Cross-space movement is not supported",
      },
      randomUUID(),
    );
    const otherParent = await createPage(
      organizationAdmin,
      otherSpace.key,
      { title: "Foreign destination", parentId: null },
      randomUUID(),
    );
    await expect(
      movePage(
        organizationAdmin,
        destinationParentId,
        {
          destinationParentId: otherParent.id,
          beforePageId: null,
          afterPageId: null,
          expectedSourceVersion: root.parentVersion,
          expectedDestinationVersion: 1,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "CROSS_SPACE_MOVE", status: 422 });

    await expect(
      movePage(
        editor,
        destinationParentId,
        {
          destinationParentId: null,
          beforePageId: null,
          afterPageId: null,
          expectedSourceVersion: root.parentVersion,
          expectedDestinationVersion: root.parentVersion,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const reorderParent = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Concurrent reorder", parentId: null },
      randomUUID(),
    );
    await publishFreshPage(organizationAdmin, reorderParent.id);
    const first = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "First", parentId: reorderParent.id },
      randomUUID(),
    );
    const second = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Second", parentId: reorderParent.id },
      randomUUID(),
    );
    const third = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Third", parentId: reorderParent.id },
      randomUUID(),
    );
    for (const page of [first, second, third]) {
      await publishFreshPage(organizationAdmin, page.id);
    }
    const reorder = await listPageTree(organizationAdmin, spaceKey, {
      parentId: reorderParent.id,
      cursor: null,
      limit: 100,
    });
    const attempts = await Promise.allSettled([
      movePage(
        organizationAdmin,
        first.id,
        {
          destinationParentId: reorderParent.id,
          beforePageId: third.id,
          afterPageId: null,
          expectedSourceVersion: reorder.parentVersion,
          expectedDestinationVersion: reorder.parentVersion,
        },
        "concurrent-reorder-a",
      ),
      movePage(
        spaceAdmin,
        second.id,
        {
          destinationParentId: reorderParent.id,
          beforePageId: null,
          afterPageId: first.id,
          expectedSourceVersion: reorder.parentVersion,
          expectedDestinationVersion: reorder.parentVersion,
        },
        "concurrent-reorder-b",
      ),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      code: "SIBLING_LIST_VERSION_CONFLICT",
      status: 409,
    });
  });

  it("rebalances only the exhausted destination list and paginates children", async () => {
    const source = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Rank source", parentId: null },
      randomUUID(),
    );
    const destination = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Rank destination", parentId: null },
      randomUUID(),
    );
    await publishFreshPage(organizationAdmin, source.id);
    await publishFreshPage(organizationAdmin, destination.id);
    const moving = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Moving rank", parentId: source.id },
      randomUUID(),
    );
    const sourceKeep = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Source rank stays", parentId: source.id },
      randomUUID(),
    );
    const destinationFirst = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Destination first", parentId: destination.id },
      randomUUID(),
    );
    const destinationSecond = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Destination second", parentId: destination.id },
      randomUUID(),
    );
    for (const page of [
      moving,
      sourceKeep,
      destinationFirst,
      destinationSecond,
    ]) {
      await publishFreshPage(organizationAdmin, page.id);
    }
    await getPool().query(
      `UPDATE pages
          SET sibling_rank = CASE id
            WHEN $1 THEN 1024.000000000000000
            WHEN $2 THEN 1024.000000000000001
          END
        WHERE organization_id = $3 AND id IN ($1, $2)`,
      [destinationFirst.id, destinationSecond.id, organizationId],
    );
    const sourceBefore = await listPageTree(organizationAdmin, spaceKey, {
      parentId: source.id,
      cursor: null,
      limit: 100,
    });
    const destinationBefore = await listPageTree(organizationAdmin, spaceKey, {
      parentId: destination.id,
      cursor: null,
      limit: 100,
    });
    await movePage(
      organizationAdmin,
      moving.id,
      {
        destinationParentId: destination.id,
        beforePageId: destinationFirst.id,
        afterPageId: destinationSecond.id,
        expectedSourceVersion: sourceBefore.parentVersion,
        expectedDestinationVersion: destinationBefore.parentVersion,
      },
      "rebalance-destination",
    );

    const ranks = await getPool().query<{
      id: string;
      sibling_rank: string;
    }>(
      `SELECT id, sibling_rank
         FROM pages
        WHERE organization_id = $1 AND id = ANY($2::uuid[])
        ORDER BY sibling_rank, id`,
      [
        organizationId,
        [destinationFirst.id, moving.id, destinationSecond.id, sourceKeep.id],
      ],
    );
    const rankById = new Map(
      ranks.rows.map((page) => [page.id, page.sibling_rank]),
    );
    expect(rankById.get(destinationFirst.id)).toBe("1024.000000000000000");
    expect(rankById.get(moving.id)).toBe("1536.000000000000000");
    expect(rankById.get(destinationSecond.id)).toBe("2048.000000000000000");
    expect(rankById.get(sourceKeep.id)).toBe("2048.000000000000000");

    const firstPage = await listPageTree(organizationAdmin, spaceKey, {
      parentId: destination.id,
      cursor: null,
      limit: 2,
    });
    expect(firstPage.items.map((page) => page.id)).toEqual([
      destinationFirst.id,
      moving.id,
    ]);
    expect(firstPage.nextCursor).toBe(moving.id);
    const secondPage = await listPageTree(organizationAdmin, spaceKey, {
      parentId: destination.id,
      cursor: firstPage.nextCursor,
      limit: 2,
    });
    expect(secondPage.items.map((page) => page.id)).toEqual([
      destinationSecond.id,
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });
});
