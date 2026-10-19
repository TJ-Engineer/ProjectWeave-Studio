import { randomUUID } from "node:crypto";
import {
  CURRENT_SCHEMA_VERSION,
  documentNodeSchema,
  emptyDocument,
  type UserIdentity,
} from "@knowledge/contracts";
import {
  closePool,
  createPage,
  createSpace,
  getPageWorkspace,
  getPool,
  listPages,
  publishPage,
  restoreRevision,
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
const userId = randomUUID();
const editorId = randomUUID();
const identity: UserIdentity = {
  id: userId,
  organizationId,
  email: `${userId}@example.test`,
  displayName: "Publication Tester",
  organizationRole: "ADMIN",
};

describe.skipIf(!testDatabaseUrl)("publication lifecycle", () => {
  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Publication Test', $2)`,
      [organizationId, `publication-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users
        (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Publication Tester', 'unused')`,
      [userId, organizationId, identity.email],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')`,
      [organizationId, userId],
    );
    await getPool().query(
      `INSERT INTO users
        (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Other Editor', 'unused')`,
      [editorId, organizationId, `${editorId}@example.test`],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'MEMBER')`,
      [organizationId, editorId],
    );
  });

  afterAll(closePool);

  it("publishes immutable revisions, rejects stale work, and restores as a new revision", async () => {
    const space = await createSpace(
      identity,
      { key: "DOCS", name: "Documentation", description: "Test knowledge" },
      randomUUID(),
    );
    const page = await createPage(
      identity,
      space.key,
      { title: "Release guide", parentId: null },
      randomUUID(),
    );
    const firstDocument = documentNodeSchema.parse({
      type: "doc",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Release", marks: [] }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Revision one", marks: [] }],
        },
      ],
    });
    let workspace = await getPageWorkspace(identity, page.id);
    const saved = await saveDraft(identity, page.id, {
      title: "Release guide",
      document: firstDocument,
      baseRevisionId: null,
      version: workspace.draft.version,
    });
    const revisionOne = await publishPage(
      identity,
      page.id,
      {
        title: saved.title,
        document: firstDocument,
        baseRevisionId: saved.baseRevisionId,
        version: saved.version,
        summary: "First publication",
      },
      "publish-revision-one",
      randomUUID(),
    );
    expect(revisionOne.number).toBe(1);

    const retry = await publishPage(
      identity,
      page.id,
      {
        title: saved.title,
        document: firstDocument,
        baseRevisionId: saved.baseRevisionId,
        version: saved.version,
        summary: "First publication",
      },
      "publish-revision-one",
      randomUUID(),
    );
    expect(retry.id).toBe(revisionOne.id);

    workspace = await getPageWorkspace(identity, page.id);
    const secondDocument = documentNodeSchema.parse({
      ...firstDocument,
      content: [
        firstDocument.content[0],
        {
          type: "paragraph",
          content: [{ type: "text", text: "Revision two", marks: [] }],
        },
      ],
    });
    const savedSecond = await saveDraft(identity, page.id, {
      title: "Release guide",
      document: secondDocument,
      baseRevisionId: revisionOne.id,
      version: workspace.draft.version,
    });
    const revisionTwo = await publishPage(
      identity,
      page.id,
      {
        title: savedSecond.title,
        document: secondDocument,
        baseRevisionId: savedSecond.baseRevisionId,
        version: savedSecond.version,
        summary: "Second publication",
      },
      "publish-revision-two",
      randomUUID(),
    );
    expect(revisionTwo.number).toBe(2);

    await expect(
      publishPage(
        identity,
        page.id,
        {
          title: saved.title,
          document: firstDocument,
          baseRevisionId: revisionOne.id,
          version: saved.version,
          summary: "Stale publication",
        },
        "publish-stale-copy",
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "PUBLICATION_CONFLICT", status: 409 });

    const restored = await restoreRevision(
      identity,
      page.id,
      1,
      {
        expectedHeadRevisionId: revisionTwo.id,
        summary: "Restore revision one",
      },
      "restore-revision-one",
      randomUUID(),
    );
    expect(restored).toMatchObject({ number: 3, document: firstDocument });
    const effects = await getPool().query<{
      audit_count: string;
      outbox_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM audit_events WHERE organization_id = $1) AS audit_count,
         (SELECT count(*) FROM outbox_events WHERE organization_id = $1) AS outbox_count`,
      [organizationId],
    );
    expect(Number(effects.rows[0]!.audit_count)).toBe(5);
    expect(Number(effects.rows[0]!.outbox_count)).toBe(5);
  });

  it("does not reveal another author's unpublished page or draft", async () => {
    const space = await createSpace(
      identity,
      { key: "SAFE", name: "Private drafts", description: "Draft boundary" },
      randomUUID(),
    );
    await getPool().query(
      `INSERT INTO space_memberships (organization_id, space_id, user_id, role)
       VALUES ($1, $2, $3, 'EDITOR')`,
      [organizationId, space.id, editorId],
    );
    const page = await createPage(
      identity,
      space.key,
      { title: "Unannounced plan", parentId: null },
      randomUUID(),
    );
    const otherEditor: UserIdentity = {
      id: editorId,
      organizationId,
      email: `${editorId}@example.test`,
      displayName: "Other Editor",
      organizationRole: "MEMBER",
    };
    await expect(listPages(otherEditor, space.key)).resolves.toMatchObject({
      pages: [],
    });
    await expect(getPageWorkspace(otherEditor, page.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("migrates stored v1 documents in memory and rewrites them only on save", async () => {
    const space = await createSpace(
      identity,
      { key: "MIGR", name: "Schema migration", description: "Editor schema" },
      randomUUID(),
    );
    const page = await createPage(
      identity,
      space.key,
      { title: "Legacy document", parentId: null },
      randomUUID(),
    );
    const legacyDocument = {
      type: "doc",
      schemaVersion: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Legacy heading" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Legacy body" }],
        },
      ],
    };
    await getPool().query(
      `UPDATE drafts
          SET body_json = $3, schema_version = 1
        WHERE organization_id = $1 AND page_id = $2`,
      [organizationId, page.id, legacyDocument],
    );

    const workspace = await getPageWorkspace(identity, page.id);
    expect(workspace.draft.document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(workspace.draft.document.content[0]).toEqual({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Legacy heading", marks: [] }],
    });
    const beforeSave = await getPool().query<{
      schema_version: number;
      json_version: number;
    }>(
      `SELECT schema_version, (body_json ->> 'schemaVersion')::int AS json_version
         FROM drafts
        WHERE organization_id = $1 AND page_id = $2`,
      [organizationId, page.id],
    );
    expect(beforeSave.rows[0]).toEqual({
      schema_version: 1,
      json_version: 1,
    });

    await saveDraft(identity, page.id, {
      title: workspace.draft.title,
      document: workspace.draft.document,
      baseRevisionId: workspace.draft.baseRevisionId,
      version: workspace.draft.version,
    });
    const afterSave = await getPool().query<{
      schema_version: number;
      json_version: number;
    }>(
      `SELECT schema_version, (body_json ->> 'schemaVersion')::int AS json_version
         FROM drafts
        WHERE organization_id = $1 AND page_id = $2`,
      [organizationId, page.id],
    );
    expect(afterSave.rows[0]).toEqual({
      schema_version: CURRENT_SCHEMA_VERSION,
      json_version: CURRENT_SCHEMA_VERSION,
    });
  });

  it("opens future documents read-only and blocks older-client save and publish", async () => {
    const space = await createSpace(
      identity,
      { key: "FUTR", name: "Future schema", description: "Compatibility" },
      randomUUID(),
    );
    const page = await createPage(
      identity,
      space.key,
      { title: "Future document", parentId: null },
      randomUUID(),
    );
    const futureDocument = {
      type: "doc",
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      clientMetadata: { preserved: true },
      content: [
        {
          type: "diagram",
          attrs: { source: "opaque" },
        },
      ],
    };
    await getPool().query(
      `UPDATE drafts
          SET body_json = $3, schema_version = $4
        WHERE organization_id = $1 AND page_id = $2`,
      [organizationId, page.id, futureDocument, futureDocument.schemaVersion],
    );

    const workspace = await getPageWorkspace(identity, page.id);
    expect(workspace.draft).toMatchObject({
      documentMode: "READ_ONLY_FUTURE",
      futureDocument,
    });
    await expect(
      saveDraft(identity, page.id, {
        title: workspace.draft.title,
        document: emptyDocument,
        baseRevisionId: workspace.draft.baseRevisionId,
        version: workspace.draft.version,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_SCHEMA_NEWER", status: 409 });
    await expect(
      publishPage(
        identity,
        page.id,
        {
          title: workspace.draft.title,
          document: emptyDocument,
          baseRevisionId: workspace.draft.baseRevisionId,
          version: workspace.draft.version,
          summary: "Unsafe older-client publication",
        },
        "future-document-publish",
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_SCHEMA_NEWER", status: 409 });
    const stored = await getPool().query<{ body_json: unknown }>(
      `SELECT body_json FROM drafts
        WHERE organization_id = $1 AND page_id = $2`,
      [organizationId, page.id],
    );
    expect(stored.rows[0]?.body_json).toEqual(futureDocument);
  });
});
