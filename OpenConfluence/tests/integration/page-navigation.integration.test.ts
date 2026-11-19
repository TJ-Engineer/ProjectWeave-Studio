import { randomUUID } from "node:crypto";
import { type UserIdentity } from "@knowledge/contracts";
import {
  closePool,
  createPage,
  createSpace,
  getPageWorkspace,
  getPool,
  getPublishedPage,
  listPageTree,
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

const organizationAdmin = identity("Navigation Organization Admin", "ADMIN");
const editor = identity("Navigation Editor");
const viewer = identity("Navigation Viewer");
const identities = [organizationAdmin, editor, viewer];

let spaceKey = "";
let publishedRootId = "";
let editorDraftId = "";
let hiddenPublishedId = "";

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
      summary: "KNW-20 navigation fixture",
    },
    `publish-${randomUUID()}`,
    randomUUID(),
  );
}

describe.skipIf(!testDatabaseUrl)("accessible page navigation", () => {
  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'KNW-20 Navigation Test', $2)`,
      [organizationId, `knw20-navigation-${organizationId}`],
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
        key: "NAVTREE",
        name: "Accessible navigation",
        description: "KNW-20 tree and explicit read/edit evidence",
      },
      randomUUID(),
    );
    spaceKey = space.key;
    let membershipVersion = 1;
    for (const [user, role] of [
      [editor, "EDITOR"],
      [viewer, "VIEWER"],
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

    publishedRootId = (
      await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Published handbook", parentId: null },
        randomUUID(),
      )
    ).id;
    await publishFreshPage(organizationAdmin, publishedRootId);

    editorDraftId = (
      await createPage(
        editor,
        spaceKey,
        { title: "Editor private outline", parentId: null },
        randomUUID(),
      )
    ).id;

    hiddenPublishedId = (
      await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Restricted strategy", parentId: null },
        randomUUID(),
      )
    ).id;
    await publishFreshPage(organizationAdmin, hiddenPublishedId);
    await updatePageRestriction(
      organizationAdmin,
      hiddenPublishedId,
      {
        restricted: true,
        memberIds: [editor.id],
        expectedVersion: 0,
      },
      randomUUID(),
    );
  });

  afterAll(closePool);

  it("returns only authorized publications and the principal's own drafts", async () => {
    const readerTree = await listPageTree(viewer, spaceKey, {
      parentId: null,
      cursor: null,
      limit: 50,
    });
    expect(readerTree.items.map((page) => page.id)).toEqual([publishedRootId]);
    expect(JSON.stringify(readerTree)).not.toContain("Editor private outline");
    expect(JSON.stringify(readerTree)).not.toContain("Restricted strategy");

    const editorTree = await listPageTree(editor, spaceKey, {
      parentId: null,
      cursor: null,
      limit: 50,
    });
    expect(editorTree.items.map((page) => page.id)).toEqual([
      publishedRootId,
      editorDraftId,
      hiddenPublishedId,
    ]);
    expect(editorTree.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: editorDraftId,
          title: "Editor private outline",
          currentRevisionId: null,
        }),
      ]),
    );
  });

  it("keeps published reads draft-free and exposes edit capability server-side", async () => {
    const readerView = await getPublishedPage(viewer, publishedRootId);
    expect(readerView).toMatchObject({
      page: { id: publishedRootId, state: "ACTIVE" },
      canEdit: false,
      readOnly: true,
    });
    const editorView = await getPublishedPage(editor, publishedRootId);
    expect(editorView.canEdit).toBe(true);

    const editorDraftsBefore = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM drafts
        WHERE organization_id = $1 AND page_id = $2 AND principal_id = $3`,
      [organizationId, publishedRootId, editor.id],
    );
    expect(editorDraftsBefore.rows[0]!.count).toBe("0");
    await getPublishedPage(editor, publishedRootId);
    const editorDraftsAfter = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM drafts
        WHERE organization_id = $1 AND page_id = $2 AND principal_id = $3`,
      [organizationId, publishedRootId, editor.id],
    );
    expect(editorDraftsAfter.rows[0]!.count).toBe("0");

    await expect(
      getPageWorkspace(viewer, publishedRootId),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    const viewerDrafts = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM drafts
        WHERE organization_id = $1 AND page_id = $2 AND principal_id = $3`,
      [organizationId, publishedRootId, viewer.id],
    );
    expect(viewerDrafts.rows[0]!.count).toBe("0");
  });

  it("blocks descendant publication until every ancestor is published", async () => {
    const parent = await createPage(
      editor,
      spaceKey,
      { title: "Unpublished parent", parentId: null },
      randomUUID(),
    );
    const child = await createPage(
      editor,
      spaceKey,
      { title: "Blocked child", parentId: parent.id },
      randomUUID(),
    );

    await expect(publishFreshPage(editor, child.id)).rejects.toMatchObject({
      code: "PAGE_ANCESTOR_UNPUBLISHED",
      status: 409,
    });
    expect(
      await getPool().query(
        `SELECT 1 FROM page_revisions
          WHERE organization_id = $1 AND page_id = $2`,
        [organizationId, child.id],
      ),
    ).toHaveProperty("rowCount", 0);

    await publishFreshPage(editor, parent.id);
    await expect(publishFreshPage(editor, child.id)).resolves.toMatchObject({
      number: 1,
      title: "Blocked child",
    });
  });
});
