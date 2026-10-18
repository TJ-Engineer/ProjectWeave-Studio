import { randomUUID } from "node:crypto";
import { type UserIdentity } from "@knowledge/contracts";
import {
  changePageLifecycle,
  closePool,
  createPage,
  createSpace,
  getPublishedPage,
  getPageWorkspace,
  getPool,
  listPageTree,
  publishPage,
  resolvePageAlias,
  restoreRevision,
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

const organizationAdmin = identity("Lifecycle Organization Admin", "ADMIN");
const spaceAdmin = identity("Lifecycle Space Admin");
const editor = identity("Lifecycle Editor");
const otherEditor = identity("Other Lifecycle Editor");
const allowedViewer = identity("Lifecycle Allowed Viewer");
const deniedViewer = identity("Lifecycle Denied Viewer");
const identities = [
  organizationAdmin,
  spaceAdmin,
  editor,
  otherEditor,
  allowedViewer,
  deniedViewer,
];

let spaceKey = "";

async function publishFreshPage(
  actor: UserIdentity,
  pageId: string,
  title?: string,
) {
  const workspace = await getPageWorkspace(actor, pageId);
  return publishPage(
    actor,
    pageId,
    {
      title: title ?? workspace.draft.title,
      document: workspace.draft.document,
      baseRevisionId: workspace.draft.baseRevisionId,
      version: workspace.draft.version,
      summary: "KNW-19 lifecycle fixture",
    },
    `publish-${randomUUID()}`,
    randomUUID(),
  );
}

async function pageVersion(pageId: string): Promise<number> {
  const result = await getPool().query<{ version: number }>(
    `SELECT version FROM pages
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, pageId],
  );
  return result.rows[0]!.version;
}

describe.skipIf(!testDatabaseUrl)(
  "durable aliases and subtree lifecycle",
  () => {
    beforeAll(async () => {
      await getPool().query(
        `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'KNW-19 Lifecycle Test', $2)`,
        [organizationId, `knw19-lifecycle-${organizationId}`],
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
          key: "LIFECYCLE",
          name: "Durable lifecycle",
          description: "KNW-19 alias and subtree lifecycle evidence",
        },
        randomUUID(),
      );
      spaceKey = space.key;
      let membershipVersion = 1;
      for (const [user, role] of [
        [spaceAdmin, "ADMIN"],
        [editor, "EDITOR"],
        [otherEditor, "EDITOR"],
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
    });

    afterAll(closePool);

    it("reserves every published title alias and resolves it to the page UUID", async () => {
      const page = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Durable alias", parentId: null },
        randomUUID(),
      );
      const first = await publishFreshPage(organizationAdmin, page.id);
      const second = await publishFreshPage(
        organizationAdmin,
        page.id,
        "Renamed handbook",
      );

      await expect(
        resolvePageAlias(organizationAdmin, spaceKey, "durable-alias"),
      ).resolves.toMatchObject({
        pageId: page.id,
        canonicalSlug: "renamed-handbook",
        state: "ACTIVE",
      });
      await expect(
        resolvePageAlias(organizationAdmin, spaceKey, "renamed-handbook"),
      ).resolves.toMatchObject({ pageId: page.id });

      const restored = await restoreRevision(
        organizationAdmin,
        page.id,
        first.number,
        {
          expectedHeadRevisionId: second.id,
          summary: "Restore the original durable title",
        },
        `restore-${randomUUID()}`,
        "restore-alias-title",
      );
      expect(restored.number).toBe(3);
      await expect(
        resolvePageAlias(organizationAdmin, spaceKey, "renamed-handbook"),
      ).resolves.toMatchObject({
        pageId: page.id,
        canonicalSlug: "durable-alias",
      });

      const collision = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Renamed handbook", parentId: null },
        randomUUID(),
      );
      expect(collision.slug).toBe("renamed-handbook-2");

      const aliases = await getPool().query<{ slug: string }>(
        `SELECT slug FROM page_aliases
        WHERE organization_id = $1 AND page_id = $2
        ORDER BY slug`,
        [organizationId, page.id],
      );
      expect(aliases.rows.map((alias) => alias.slug)).toEqual([
        "durable-alias",
        "renamed-handbook",
      ]);
      const renameEffects = await getPool().query<{ count: string }>(
        `SELECT count(*)
         FROM audit_events
        WHERE organization_id = $1 AND target_id = $2
          AND action = 'page.renamed'`,
        [organizationId, page.id],
      );
      expect(renameEffects.rows[0]!.count).toBe("2");
    });

    it("archives, restores, and trashes a published subtree atomically", async () => {
      const parent = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Restricted lifecycle parent", parentId: null },
        randomUUID(),
      );
      const root = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Published lifecycle root", parentId: parent.id },
        randomUUID(),
      );
      const child = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Published lifecycle child", parentId: root.id },
        randomUUID(),
      );
      for (const page of [parent, root, child]) {
        await publishFreshPage(organizationAdmin, page.id);
      }
      await updatePageRestriction(
        organizationAdmin,
        parent.id,
        {
          restricted: true,
          memberIds: [allowedViewer.id, editor.id],
          expectedVersion: 0,
        },
        randomUUID(),
      );

      const beforeCounts = await getPool().query<{
        draft_count: string;
        revision_count: string;
      }>(
        `SELECT
        (SELECT count(*) FROM drafts WHERE page_id = ANY($1::uuid[]))
          AS draft_count,
        (SELECT count(*) FROM page_revisions WHERE page_id = ANY($1::uuid[]))
          AS revision_count`,
        [[root.id, child.id]],
      );
      const tree = await listPageTree(organizationAdmin, spaceKey, {
        parentId: parent.id,
        cursor: null,
        limit: 100,
      });

      await expect(
        changePageLifecycle(
          editor,
          root.id,
          {
            action: "ARCHIVE",
            expectedVersion: await pageVersion(root.id),
            expectedParentVersion: tree.parentVersion,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

      const archived = await changePageLifecycle(
        organizationAdmin,
        root.id,
        {
          action: "ARCHIVE",
          expectedVersion: await pageVersion(root.id),
          expectedParentVersion: tree.parentVersion,
        },
        "archive-published-subtree",
      );
      expect(archived).toMatchObject({
        action: "ARCHIVE",
        affectedPageCount: 2,
        restrictionMaterialized: true,
        restoredToFallback: false,
        page: { id: root.id, state: "ARCHIVED" },
      });
      await expect(
        resolvePageAlias(allowedViewer, spaceKey, root.slug),
      ).resolves.toMatchObject({ pageId: root.id, state: "ARCHIVED" });
      await expect(
        getPublishedPage(allowedViewer, root.id),
      ).resolves.toMatchObject({
        page: { id: root.id, state: "ARCHIVED" },
        readOnly: true,
      });
      await expect(
        getPublishedPage(deniedViewer, root.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        resolvePageAlias(deniedViewer, spaceKey, root.slug),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        getPageWorkspace(organizationAdmin, root.id),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      expect(
        (
          await listPageTree(organizationAdmin, spaceKey, {
            parentId: parent.id,
            cursor: null,
            limit: 100,
          })
        ).items.map((page) => page.id),
      ).not.toContain(root.id);

      const afterArchiveCounts = await getPool().query<{
        draft_count: string;
        revision_count: string;
      }>(
        `SELECT
        (SELECT count(*) FROM drafts WHERE page_id = ANY($1::uuid[]))
          AS draft_count,
        (SELECT count(*) FROM page_revisions WHERE page_id = ANY($1::uuid[]))
          AS revision_count`,
        [[root.id, child.id]],
      );
      expect(afterArchiveCounts.rows[0]).toEqual(beforeCounts.rows[0]);

      const restored = await changePageLifecycle(
        organizationAdmin,
        root.id,
        {
          action: "RESTORE",
          expectedVersion: archived.page.version,
          expectedParentVersion: archived.parentVersion,
        },
        "restore-published-subtree",
      );
      expect(restored).toMatchObject({
        action: "RESTORE",
        affectedPageCount: 2,
        restoredToFallback: false,
        page: { id: root.id, parentId: parent.id, state: "ACTIVE" },
      });

      const trashed = await changePageLifecycle(
        organizationAdmin,
        root.id,
        {
          action: "TRASH",
          expectedVersion: restored.page.version,
          expectedParentVersion: restored.parentVersion,
        },
        "trash-published-subtree",
      );
      expect(trashed).toMatchObject({
        affectedPageCount: 2,
        page: { state: "TRASHED" },
      });
      await expect(
        resolvePageAlias(organizationAdmin, spaceKey, root.slug),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

      const effects = await getPool().query<{
        audit_count: string;
        outbox_count: string;
      }>(
        `SELECT
        (SELECT count(*) FROM audit_events
          WHERE organization_id = $1
            AND correlation_id IN ($2, $3, $4)) AS audit_count,
        (SELECT count(*) FROM outbox_events
          WHERE organization_id = $1 AND aggregate_id = $5
            AND topic IN ('page.archived', 'page.restored', 'page.trashed'))
          AS outbox_count`,
        [
          organizationId,
          "archive-published-subtree",
          "restore-published-subtree",
          "trash-published-subtree",
          root.id,
        ],
      );
      expect(effects.rows[0]).toEqual({
        audit_count: "3",
        outbox_count: "3",
      });
    });

    it("requires an active fallback parent and preserves access on restore", async () => {
      const originalParent = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Fallback original parent", parentId: null },
        randomUUID(),
      );
      const child = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Fallback child", parentId: originalParent.id },
        randomUUID(),
      );
      const destination = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Fallback destination", parentId: null },
        randomUUID(),
      );
      for (const page of [originalParent, child, destination]) {
        await publishFreshPage(organizationAdmin, page.id);
      }
      await updatePageRestriction(
        organizationAdmin,
        originalParent.id,
        {
          restricted: true,
          memberIds: [allowedViewer.id],
          expectedVersion: 0,
        },
        randomUUID(),
      );

      const originalChildren = await listPageTree(organizationAdmin, spaceKey, {
        parentId: originalParent.id,
        cursor: null,
        limit: 100,
      });
      const trashed = await changePageLifecycle(
        organizationAdmin,
        child.id,
        {
          action: "TRASH",
          expectedVersion: await pageVersion(child.id),
          expectedParentVersion: originalChildren.parentVersion,
        },
        randomUUID(),
      );
      expect(trashed.restrictionMaterialized).toBe(true);

      const roots = await listPageTree(organizationAdmin, spaceKey, {
        parentId: null,
        cursor: null,
        limit: 100,
      });
      await changePageLifecycle(
        organizationAdmin,
        originalParent.id,
        {
          action: "ARCHIVE",
          expectedVersion: await pageVersion(originalParent.id),
          expectedParentVersion: roots.parentVersion,
        },
        randomUUID(),
      );

      await expect(
        changePageLifecycle(
          organizationAdmin,
          child.id,
          {
            action: "RESTORE",
            expectedVersion: trashed.page.version,
            expectedParentVersion: trashed.parentVersion,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({
        code: "RESTORE_DESTINATION_REQUIRED",
        status: 422,
      });

      const destinationChildren = await listPageTree(
        organizationAdmin,
        spaceKey,
        { parentId: destination.id, cursor: null, limit: 100 },
      );
      const restored = await changePageLifecycle(
        organizationAdmin,
        child.id,
        {
          action: "RESTORE",
          expectedVersion: trashed.page.version,
          expectedParentVersion: destinationChildren.parentVersion,
          destinationParentId: destination.id,
          beforePageId: null,
          afterPageId: null,
        },
        randomUUID(),
      );
      expect(restored).toMatchObject({
        restoredToFallback: true,
        page: { parentId: destination.id, state: "ACTIVE" },
      });
      expect(
        (
          await listPageTree(allowedViewer, spaceKey, {
            parentId: destination.id,
            cursor: null,
            limit: 100,
          })
        ).items.map((page) => page.id),
      ).toContain(child.id);
      expect(
        (
          await listPageTree(deniedViewer, spaceKey, {
            parentId: destination.id,
            cursor: null,
            limit: 100,
          })
        ).items.map((page) => page.id),
      ).not.toContain(child.id);
    });

    it("keeps independently archived branches outside a later parent transition", async () => {
      const parent = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Independent lifecycle parent", parentId: null },
        randomUUID(),
      );
      const child = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Independently archived child", parentId: parent.id },
        randomUUID(),
      );
      await publishFreshPage(organizationAdmin, parent.id);
      await publishFreshPage(organizationAdmin, child.id);

      const children = await listPageTree(organizationAdmin, spaceKey, {
        parentId: parent.id,
        cursor: null,
        limit: 100,
      });
      await changePageLifecycle(
        organizationAdmin,
        child.id,
        {
          action: "ARCHIVE",
          expectedVersion: await pageVersion(child.id),
          expectedParentVersion: children.parentVersion,
        },
        randomUUID(),
      );

      const roots = await listPageTree(organizationAdmin, spaceKey, {
        parentId: null,
        cursor: null,
        limit: 100,
      });
      const archivedParent = await changePageLifecycle(
        organizationAdmin,
        parent.id,
        {
          action: "ARCHIVE",
          expectedVersion: await pageVersion(parent.id),
          expectedParentVersion: roots.parentVersion,
        },
        randomUUID(),
      );
      expect(archivedParent.affectedPageCount).toBe(1);

      const restoredParent = await changePageLifecycle(
        organizationAdmin,
        parent.id,
        {
          action: "RESTORE",
          expectedVersion: archivedParent.page.version,
          expectedParentVersion: archivedParent.parentVersion,
        },
        randomUUID(),
      );
      expect(restoredParent.affectedPageCount).toBe(1);
      const states = await getPool().query<{ id: string; state: string }>(
        `SELECT id, state FROM pages WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[parent.id, child.id]],
      );
      expect(new Map(states.rows.map((page) => [page.id, page.state]))).toEqual(
        new Map([
          [parent.id, "ACTIVE"],
          [child.id, "ARCHIVED"],
        ]),
      );
    });

    it("restores between surviving original neighbors after ranks change", async () => {
      const parent = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Relative position parent", parentId: null },
        randomUUID(),
      );
      const before = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Relative before", parentId: parent.id },
        randomUUID(),
      );
      const target = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Relative target", parentId: parent.id },
        randomUUID(),
      );
      const after = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Relative after", parentId: parent.id },
        randomUUID(),
      );
      for (const page of [parent, before, target, after]) {
        await publishFreshPage(organizationAdmin, page.id);
      }

      const children = await listPageTree(organizationAdmin, spaceKey, {
        parentId: parent.id,
        cursor: null,
        limit: 100,
      });
      const archived = await changePageLifecycle(
        organizationAdmin,
        target.id,
        {
          action: "ARCHIVE",
          expectedVersion: await pageVersion(target.id),
          expectedParentVersion: children.parentVersion,
        },
        randomUUID(),
      );
      await getPool().query(
        `UPDATE pages
          SET sibling_rank = CASE id
            WHEN $1 THEN 5000
            WHEN $2 THEN 5001
          END
        WHERE organization_id = $3 AND id IN ($1, $2)`,
        [before.id, after.id, organizationId],
      );

      await changePageLifecycle(
        organizationAdmin,
        target.id,
        {
          action: "RESTORE",
          expectedVersion: archived.page.version,
          expectedParentVersion: archived.parentVersion,
        },
        randomUUID(),
      );
      const restored = await listPageTree(organizationAdmin, spaceKey, {
        parentId: parent.id,
        cursor: null,
        limit: 100,
      });
      expect(restored.items.map((page) => page.id)).toEqual([
        before.id,
        target.id,
        after.id,
      ]);
    });

    it("lets editors recover only their own never-published subtree", async () => {
      const ownRoot = await createPage(
        editor,
        spaceKey,
        { title: "Private editor root", parentId: null },
        randomUUID(),
      );
      const ownChild = await createPage(
        editor,
        spaceKey,
        { title: "Private editor child", parentId: ownRoot.id },
        randomUUID(),
      );
      const roots = await listPageTree(editor, spaceKey, {
        parentId: null,
        cursor: null,
        limit: 100,
      });
      const draftsBefore = await getPool().query<{ count: string }>(
        `SELECT count(*) FROM drafts WHERE page_id = ANY($1::uuid[])`,
        [[ownRoot.id, ownChild.id]],
      );
      const trashed = await changePageLifecycle(
        editor,
        ownRoot.id,
        {
          action: "TRASH",
          expectedVersion: ownRoot.version,
          expectedParentVersion: roots.parentVersion,
        },
        randomUUID(),
      );
      expect(trashed).toMatchObject({
        affectedPageCount: 2,
        page: { state: "TRASHED" },
      });
      await expect(
        changePageLifecycle(
          otherEditor,
          ownRoot.id,
          {
            action: "RESTORE",
            expectedVersion: trashed.page.version,
            expectedParentVersion: trashed.parentVersion,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

      const restored = await changePageLifecycle(
        editor,
        ownRoot.id,
        {
          action: "RESTORE",
          expectedVersion: trashed.page.version,
          expectedParentVersion: trashed.parentVersion,
        },
        randomUUID(),
      );
      expect(restored.page.state).toBe("ACTIVE");
      const draftsAfter = await getPool().query<{ count: string }>(
        `SELECT count(*) FROM drafts WHERE page_id = ANY($1::uuid[])`,
        [[ownRoot.id, ownChild.id]],
      );
      expect(draftsAfter.rows[0]).toEqual(draftsBefore.rows[0]);

      const publishedParent = await createPage(
        organizationAdmin,
        spaceKey,
        { title: "Published parent with private child", parentId: null },
        randomUUID(),
      );
      await publishFreshPage(organizationAdmin, publishedParent.id);
      const privateChild = await createPage(
        editor,
        spaceKey,
        {
          title: "Another principal private child",
          parentId: publishedParent.id,
        },
        randomUUID(),
      );
      const rootTree = await listPageTree(organizationAdmin, spaceKey, {
        parentId: null,
        cursor: null,
        limit: 100,
      });
      await expect(
        changePageLifecycle(
          organizationAdmin,
          publishedParent.id,
          {
            action: "TRASH",
            expectedVersion: await pageVersion(publishedParent.id),
            expectedParentVersion: rootTree.parentVersion,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({
        code: "SUBTREE_PRIVATE_DRAFTS",
        status: 409,
        message: expect.stringContaining("1 unpublished page"),
      });
      const states = await getPool().query<{ id: string; state: string }>(
        `SELECT id, state FROM pages WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[publishedParent.id, privateChild.id]],
      );
      expect(states.rows.every((page) => page.state === "ACTIVE")).toBe(true);
    });
  },
);
