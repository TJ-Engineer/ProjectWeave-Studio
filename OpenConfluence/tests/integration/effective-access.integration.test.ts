import { randomUUID } from "node:crypto";
import { emptyDocument, type UserIdentity } from "@knowledge/contracts";
import {
  closePool,
  createPage,
  createSpace,
  getPageWorkspace,
  getPool,
  listPages,
  listRevisions,
  listSpaces,
  publishPage,
  saveDraft,
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
const editorAllowedAtRoot = identity("Root Editor");
const editorAllowedOnlyAtChild = identity("Child Editor");
const viewerAllowed = identity("Allowed Viewer");
const organizationMemberOnly = identity("Organization Member");
const identities = [
  organizationAdmin,
  spaceAdmin,
  editorAllowedAtRoot,
  editorAllowedOnlyAtChild,
  viewerAllowed,
  organizationMemberOnly,
];

async function publishFreshPage(
  actor: UserIdentity,
  pageId: string,
  idempotencyKey: string,
) {
  const workspace = await getPageWorkspace(actor, pageId);
  const input = {
    title: workspace.draft.title,
    document: workspace.draft.document,
    baseRevisionId: workspace.draft.baseRevisionId,
    version: workspace.draft.version,
    summary: "Effective-access fixture",
  };
  const revision = await publishPage(
    actor,
    pageId,
    input,
    idempotencyKey,
    randomUUID(),
  );
  return { input, revision, originalDraftId: workspace.draft.id };
}

describe.skipIf(!testDatabaseUrl)("effective page access", () => {
  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Effective Access Test', $2)`,
      [organizationId, `effective-access-${organizationId}`],
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
  });

  afterAll(closePool);

  it("filters inherited restrictions before projection and preserves private drafts", async () => {
    const space = await createSpace(
      organizationAdmin,
      {
        key: "SECURE",
        name: "Secure Space",
        description: "Private by default",
      },
      randomUUID(),
    );
    await getPool().query(
      `INSERT INTO space_memberships
        (organization_id, space_id, user_id, role)
       VALUES
        ($1, $2, $3, 'ADMIN'),
        ($1, $2, $4, 'EDITOR'),
        ($1, $2, $5, 'EDITOR'),
        ($1, $2, $6, 'VIEWER')`,
      [
        organizationId,
        space.id,
        spaceAdmin.id,
        editorAllowedAtRoot.id,
        editorAllowedOnlyAtChild.id,
        viewerAllowed.id,
      ],
    );

    const root = await createPage(
      organizationAdmin,
      space.key,
      { title: "Restricted root", parentId: null },
      randomUUID(),
    );
    const rootPublication = await publishFreshPage(
      organizationAdmin,
      root.id,
      `root-${randomUUID()}`,
    );
    const child = await createPage(
      organizationAdmin,
      space.key,
      { title: "Restricted child", parentId: root.id },
      randomUUID(),
    );
    await publishFreshPage(
      organizationAdmin,
      child.id,
      `child-${randomUUID()}`,
    );
    const privatePage = await createPage(
      editorAllowedOnlyAtChild,
      space.key,
      { title: "Private work", parentId: null },
      randomUUID(),
    );

    await getPool().query(
      `INSERT INTO page_restrictions
        (organization_id, space_id, page_id, created_by)
       VALUES ($1, $2, $3, $5), ($1, $2, $4, $5)`,
      [organizationId, space.id, root.id, child.id, organizationAdmin.id],
    );
    await getPool().query(
      `INSERT INTO page_restriction_members
        (organization_id, space_id, page_id, user_id)
       VALUES
        ($1, $2, $3, $5),
        ($1, $2, $3, $7),
        ($1, $2, $4, $6),
        ($1, $2, $4, $7)`,
      [
        organizationId,
        space.id,
        root.id,
        child.id,
        editorAllowedAtRoot.id,
        editorAllowedOnlyAtChild.id,
        viewerAllowed.id,
      ],
    );

    const pageIdsFor = async (actor: UserIdentity) =>
      new Set((await listPages(actor, space.key)).pages.map((page) => page.id));

    expect(await pageIdsFor(organizationAdmin)).toEqual(
      new Set([root.id, child.id]),
    );
    expect(await pageIdsFor(spaceAdmin)).toEqual(new Set([root.id, child.id]));
    expect(await pageIdsFor(editorAllowedAtRoot)).toEqual(new Set([root.id]));
    expect(await pageIdsFor(editorAllowedOnlyAtChild)).toEqual(
      new Set([privatePage.id]),
    );
    expect(await pageIdsFor(viewerAllowed)).toEqual(
      new Set([root.id, child.id]),
    );
    await expect(listSpaces(organizationMemberOnly)).resolves.toEqual([]);
    await expect(
      listPages(organizationMemberOnly, space.key),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    await expect(
      getPageWorkspace(editorAllowedOnlyAtChild, root.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      getPageWorkspace(viewerAllowed, root.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(
      getPageWorkspace(spaceAdmin, privatePage.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      getPageWorkspace(editorAllowedOnlyAtChild, privatePage.id),
    ).resolves.toMatchObject({ page: { id: privatePage.id } });

    const administratorWorkspace = await getPageWorkspace(spaceAdmin, root.id);
    expect(administratorWorkspace.draft.id).not.toBe(
      rootPublication.originalDraftId,
    );
    await expect(listRevisions(viewerAllowed, root.id)).resolves.toHaveLength(
      1,
    );
    await expect(
      listRevisions(editorAllowedOnlyAtChild, root.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    await expect(
      saveDraft(viewerAllowed, root.id, {
        title: "Viewer mutation",
        document: emptyDocument,
        baseRevisionId: rootPublication.revision.id,
        version: 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const replayPage = await createPage(
      editorAllowedAtRoot,
      space.key,
      { title: "Revocation replay", parentId: null },
      randomUUID(),
    );
    const replayKey = `replay-${randomUUID()}`;
    const replayPublication = await publishFreshPage(
      editorAllowedAtRoot,
      replayPage.id,
      replayKey,
    );
    await getPool().query(
      `DELETE FROM space_memberships
        WHERE organization_id = $1 AND space_id = $2 AND user_id = $3`,
      [organizationId, space.id, editorAllowedAtRoot.id],
    );
    await expect(
      publishPage(
        editorAllowedAtRoot,
        replayPage.id,
        replayPublication.input,
        replayKey,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});
