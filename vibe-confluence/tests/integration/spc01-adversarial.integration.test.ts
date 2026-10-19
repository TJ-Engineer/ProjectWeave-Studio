import { randomUUID } from "node:crypto";
import {
  CURRENT_SCHEMA_VERSION,
  type DocumentNode,
  type UserIdentity,
} from "@knowledge/contracts";
import {
  closePool,
  createPage,
  createSpace,
  getIdentity,
  getPageRestrictionAdministration,
  getPageWorkspace,
  getPool,
  listPages,
  listRevisions,
  listSpaces,
  listSpaceMembers,
  publishPage,
  removeSpaceMember,
  saveDraft,
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

const organizationAdmin = identity("Organization Admin", "ADMIN");
const spaceAdmin = identity("Space Admin");
const editorAllowed = identity("Allowed Editor");
const editorDenied = identity("Denied Editor");
const viewerAllowed = identity("Allowed Viewer");
const viewerDenied = identity("Denied Viewer");
const organizationMemberOnly = identity("Organization Member Only");
const emergencyOwner = identity("Emergency Owner");
const identities = [
  organizationAdmin,
  spaceAdmin,
  editorAllowed,
  editorDenied,
  viewerAllowed,
  viewerDenied,
  organizationMemberOnly,
  emergencyOwner,
];

const secretDocument: DocumentNode = {
  type: "doc",
  schemaVersion: CURRENT_SCHEMA_VERSION,
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "sealed private draft body", marks: [] }],
    },
  ],
};

let spaceId = "";
let spaceKey = "";
let membershipVersion = 0;
let openPageId = "";
let restrictedRootId = "";
let restrictedChildId = "";
let editorPrivatePageId = "";
let emergencyPrivatePageId = "";
let sharedPageId = "";
let secretDraftId = "";

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
      summary: "SPC-01 adversarial fixture",
    },
    `publish-${randomUUID()}`,
    randomUUID(),
  );
}

describe.skipIf(!testDatabaseUrl)("SPC-01 adversarial access evidence", () => {
  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'SPC-01 Adversarial Test', $2)`,
      [organizationId, `spc01-adversarial-${organizationId}`],
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
        key: "ADVERSARY",
        name: "Adversarial Access",
        description: "SPC-01 role and content-state matrix",
      },
      randomUUID(),
    );
    spaceId = space.id;
    spaceKey = space.key;
    membershipVersion = 1;
    for (const [user, role] of [
      [spaceAdmin, "ADMIN"],
      [editorAllowed, "EDITOR"],
      [editorDenied, "EDITOR"],
      [viewerAllowed, "VIEWER"],
      [viewerDenied, "VIEWER"],
      [emergencyOwner, "EDITOR"],
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

    const openPage = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Published open page", parentId: null },
      randomUUID(),
    );
    openPageId = openPage.id;
    await publishFreshPage(organizationAdmin, openPageId);

    const restrictedRoot = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Restricted root", parentId: null },
      randomUUID(),
    );
    restrictedRootId = restrictedRoot.id;
    await publishFreshPage(organizationAdmin, restrictedRootId);

    const restrictedChild = await createPage(
      organizationAdmin,
      spaceKey,
      { title: "Restricted child", parentId: restrictedRootId },
      randomUUID(),
    );
    restrictedChildId = restrictedChild.id;
    await publishFreshPage(organizationAdmin, restrictedChildId);

    const sharedPage = await createPage(
      editorDenied,
      spaceKey,
      { title: "Published shared page", parentId: null },
      randomUUID(),
    );
    sharedPageId = sharedPage.id;
    await publishFreshPage(editorDenied, sharedPageId);
    const editorWorkspace = await getPageWorkspace(editorDenied, sharedPageId);
    const secretDraft = await saveDraft(editorDenied, sharedPageId, {
      title: "Sealed private draft title",
      document: secretDocument,
      baseRevisionId: editorWorkspace.draft.baseRevisionId,
      version: editorWorkspace.draft.version,
    });
    secretDraftId = secretDraft.id;

    editorPrivatePageId = (
      await createPage(
        editorDenied,
        spaceKey,
        { title: "Editor unpublished page", parentId: null },
        randomUUID(),
      )
    ).id;
    emergencyPrivatePageId = (
      await createPage(
        emergencyOwner,
        spaceKey,
        { title: "Emergency sealed page", parentId: null },
        randomUUID(),
      )
    ).id;

    await updatePageRestriction(
      organizationAdmin,
      restrictedRootId,
      {
        restricted: true,
        memberIds: [editorAllowed.id, viewerAllowed.id, emergencyOwner.id],
        expectedVersion: 0,
      },
      randomUUID(),
    );
    await updatePageRestriction(
      organizationAdmin,
      restrictedChildId,
      {
        restricted: true,
        memberIds: [editorDenied.id, viewerAllowed.id],
        expectedVersion: 0,
      },
      randomUUID(),
    );
  });

  afterAll(closePool);

  it("enforces the role, publication, ownership, and inherited-policy matrix", async () => {
    const pageIdsFor = async (actor: UserIdentity) =>
      new Set((await listPages(actor, spaceKey)).pages.map((page) => page.id));

    const publishedPages = new Set([
      openPageId,
      restrictedRootId,
      restrictedChildId,
      sharedPageId,
    ]);
    expect(await pageIdsFor(organizationAdmin)).toEqual(publishedPages);
    expect(await pageIdsFor(spaceAdmin)).toEqual(publishedPages);
    expect(await pageIdsFor(editorAllowed)).toEqual(
      new Set([openPageId, restrictedRootId, sharedPageId]),
    );
    expect(await pageIdsFor(editorDenied)).toEqual(
      new Set([openPageId, sharedPageId, editorPrivatePageId]),
    );
    expect(await pageIdsFor(viewerAllowed)).toEqual(publishedPages);
    expect(await pageIdsFor(viewerDenied)).toEqual(
      new Set([openPageId, sharedPageId]),
    );
    expect(await pageIdsFor(emergencyOwner)).toEqual(
      new Set([
        openPageId,
        restrictedRootId,
        sharedPageId,
        emergencyPrivatePageId,
      ]),
    );

    await expect(listSpaces(organizationMemberOnly)).resolves.toEqual([]);
    await expect(
      listPages(organizationMemberOnly, spaceKey),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    for (const administrator of [organizationAdmin, spaceAdmin]) {
      await expect(
        getPageWorkspace(administrator, editorPrivatePageId),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        getPageWorkspace(administrator, emergencyPrivatePageId),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

      const administratorWorkspace = await getPageWorkspace(
        administrator,
        sharedPageId,
      );
      expect(administratorWorkspace.draft).toMatchObject({
        title: "Published shared page",
      });
      expect(administratorWorkspace.draft.id).not.toBe(secretDraftId);
      expect(administratorWorkspace.draft.document).not.toEqual(secretDocument);
    }

    await expect(
      getPageWorkspace(editorDenied, editorPrivatePageId),
    ).resolves.toMatchObject({ page: { id: editorPrivatePageId } });
    await expect(
      getPageWorkspace(editorAllowed, restrictedChildId),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      getPageWorkspace(viewerAllowed, openPageId),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(
      listRevisions(viewerDenied, sharedPageId),
    ).resolves.toHaveLength(1);
    await expect(
      listRevisions(viewerDenied, restrictedRootId),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("revokes emergency access, prunes grants, and requires explicit restoration", async () => {
    const beforeDeactivation = await listSpaceMembers(
      organizationAdmin,
      spaceKey,
      { kind: "members", query: "", cursor: null, limit: 50 },
    );
    expect(beforeDeactivation.membershipVersion).toBe(membershipVersion);
    expect(
      beforeDeactivation.items.find(
        (member) => member.userId === emergencyOwner.id,
      ),
    ).toMatchObject({ pageGrantCount: 1, unpublishedPageCount: 1 });

    const lastAdminSpace = await createSpace(
      organizationAdmin,
      {
        key: "LASTADMIN",
        name: "Emergency last administrator",
        description: "Deactivation overrides the ordinary last-admin guard",
      },
      randomUUID(),
    );
    const addedEmergencyAdmin = await upsertSpaceMember(
      organizationAdmin,
      lastAdminSpace.key,
      emergencyOwner.id,
      { role: "ADMIN", expectedMembershipVersion: 1 },
      randomUUID(),
    );
    const removedCreator = await removeSpaceMember(
      organizationAdmin,
      lastAdminSpace.key,
      organizationAdmin.id,
      addedEmergencyAdmin.membershipVersion,
      randomUUID(),
    );

    await getPool().query(
      `UPDATE users SET state = 'DEACTIVATED'
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, emergencyOwner.id],
    );

    await expect(getIdentity(emergencyOwner.id)).resolves.toBeNull();
    await expect(listSpaces(emergencyOwner)).resolves.toEqual([]);
    const revoked = await getPool().query<{
      grant_count: string;
      main_membership_count: string;
      main_membership_version: number;
      page_count: string;
      private_draft_count: string;
      spare_membership_count: string;
      spare_membership_version: number;
    }>(
      `SELECT
        (SELECT count(*) FROM space_memberships
          WHERE organization_id = $1 AND space_id = $2 AND user_id = $3)
          AS main_membership_count,
        (SELECT membership_version FROM spaces WHERE id = $2)
          AS main_membership_version,
        (SELECT count(*) FROM page_restriction_members
          WHERE organization_id = $1 AND user_id = $3)
          AS grant_count,
        (SELECT count(*) FROM space_memberships
          WHERE organization_id = $1 AND space_id = $4 AND user_id = $3)
          AS spare_membership_count,
        (SELECT membership_version FROM spaces WHERE id = $4)
          AS spare_membership_version,
        (SELECT count(*) FROM pages WHERE id = $5 AND created_by = $3)
          AS page_count,
        (SELECT count(*) FROM drafts
          WHERE page_id = $5 AND principal_id = $3)
          AS private_draft_count`,
      [
        organizationId,
        spaceId,
        emergencyOwner.id,
        lastAdminSpace.id,
        emergencyPrivatePageId,
      ],
    );
    expect(revoked.rows[0]).toEqual({
      grant_count: "0",
      main_membership_count: "0",
      main_membership_version: membershipVersion + 1,
      page_count: "1",
      private_draft_count: "1",
      spare_membership_count: "0",
      spare_membership_version: removedCreator.membershipVersion + 1,
    });
    await expect(
      getPageRestrictionAdministration(organizationAdmin, restrictedRootId),
    ).resolves.toMatchObject({
      memberIds: [editorAllowed.id, viewerAllowed.id].sort(),
      version: 2,
    });
    await expect(
      getPageWorkspace(organizationAdmin, emergencyPrivatePageId),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    await getPool().query(
      `UPDATE users SET state = 'ACTIVE'
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, emergencyOwner.id],
    );
    await expect(getIdentity(emergencyOwner.id)).resolves.toMatchObject({
      id: emergencyOwner.id,
    });
    await expect(listSpaces(emergencyOwner)).resolves.toEqual([]);
    await expect(
      getPageWorkspace(emergencyOwner, emergencyPrivatePageId),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    await expect(
      upsertSpaceMember(
        organizationAdmin,
        spaceKey,
        emergencyOwner.id,
        { role: "EDITOR", expectedMembershipVersion: membershipVersion },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    const explicitlyRestored = await upsertSpaceMember(
      organizationAdmin,
      spaceKey,
      emergencyOwner.id,
      {
        role: "EDITOR",
        expectedMembershipVersion: membershipVersion + 1,
      },
      randomUUID(),
    );
    expect(explicitlyRestored).toMatchObject({
      affectedPageGrantCount: 0,
      member: { pageGrantCount: 0, unpublishedPageCount: 1 },
      membershipVersion: membershipVersion + 2,
    });
    await expect(
      updatePageRestriction(
        organizationAdmin,
        restrictedRootId,
        {
          restricted: true,
          memberIds: [editorAllowed.id, viewerAllowed.id, emergencyOwner.id],
          expectedVersion: 1,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    expect(await listSpaces(emergencyOwner)).toHaveLength(1);
    await expect(
      getPageWorkspace(emergencyOwner, emergencyPrivatePageId),
    ).resolves.toMatchObject({ page: { id: emergencyPrivatePageId } });
    const restoredPages = await listPages(emergencyOwner, spaceKey);
    expect(restoredPages.pages.map((page) => page.id)).not.toContain(
      restrictedRootId,
    );

    const restoredGrant = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM page_restriction_members
        WHERE organization_id = $1 AND page_id = $2 AND user_id = $3`,
      [organizationId, restrictedRootId, emergencyOwner.id],
    );
    expect(restoredGrant.rows[0]!.count).toBe("0");
    await expect(
      listSpaceMembers(organizationAdmin, lastAdminSpace.key, {
        kind: "members",
        query: "",
        cursor: null,
        limit: 50,
      }),
    ).resolves.toMatchObject({ items: [] });
  });
});
