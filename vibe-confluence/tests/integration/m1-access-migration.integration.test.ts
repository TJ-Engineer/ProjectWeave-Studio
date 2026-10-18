import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (
  testDatabaseUrl &&
  !new URL(testDatabaseUrl).pathname.slice(1).endsWith("_test")
) {
  throw new Error("Integration tests require a database name ending in _test");
}

const pool = testDatabaseUrl
  ? new Pool({ connectionString: testDatabaseUrl, max: 2 })
  : null;
const m0Migration = await readFile(
  new URL(
    "../../packages/database/migrations/0001_publication_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const m1Migration = await readFile(
  new URL(
    "../../packages/database/migrations/0002_m1_access_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const effectiveAccessMigration = await readFile(
  new URL(
    "../../packages/database/migrations/0003_effective_page_access.sql",
    import.meta.url,
  ),
  "utf8",
);
const accessAdministrationMigration = await readFile(
  new URL(
    "../../packages/database/migrations/0004_access_administration.sql",
    import.meta.url,
  ),
  "utf8",
);
const emergencyDeactivationMigration = await readFile(
  new URL(
    "../../packages/database/migrations/0005_emergency_deactivation.sql",
    import.meta.url,
  ),
  "utf8",
);

async function applyMigration(client: PoolClient, sql: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function inIsolatedSchema(
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  if (!pool) throw new Error("TEST_DATABASE_URL is required");
  const client = await pool.connect();
  const schema = `knw14_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await work(client);
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
  }
}

describe.skipIf(!testDatabaseUrl)("M1 access foundation migration", () => {
  afterAll(async () => {
    await pool?.end();
  });

  it("applies the M0 and M1 migrations to a clean schema", async () => {
    await inIsolatedSchema(async (client) => {
      await applyMigration(client, m0Migration);
      await applyMigration(client, m1Migration);
      await applyMigration(client, effectiveAccessMigration);
      await applyMigration(client, accessAdministrationMigration);
      await applyMigration(client, emergencyDeactivationMigration);

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name IN (
              'space_memberships',
              'page_aliases',
              'page_restrictions',
              'page_restriction_members'
            )
          ORDER BY table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "page_aliases",
        "page_restriction_members",
        "page_restrictions",
        "space_memberships",
      ]);

      const columns = await client.query<{
        column_name: string;
        table_name: string;
      }>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND (
              (table_name = 'spaces' AND column_name = 'membership_version')
              OR (table_name = 'drafts' AND column_name = 'principal_id')
            )
          ORDER BY table_name, column_name`,
      );
      expect(columns.rows).toEqual([
        { table_name: "drafts", column_name: "principal_id" },
        { table_name: "spaces", column_name: "membership_version" },
      ]);

      await expect(
        client.query<{ present: boolean }>(
          `SELECT to_regprocedure(
             'has_effective_page_access(uuid,uuid,uuid)'
           ) IS NOT NULL AS present`,
        ),
      ).resolves.toMatchObject({ rows: [{ present: true }] });

      await expect(
        client.query<{ present: boolean }>(
          `SELECT to_regprocedure(
             'revoke_deactivated_user_access()'
           ) IS NOT NULL AS present`,
        ),
      ).resolves.toMatchObject({ rows: [{ present: true }] });

      await expect(
        client.query<{ column_default: string; is_nullable: string }>(
          `SELECT column_default, is_nullable
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'page_restrictions'
              AND column_name = 'enabled'`,
        ),
      ).resolves.toMatchObject({
        rows: [{ column_default: "true", is_nullable: "NO" }],
      });
    });
  });

  it("upgrades an M0 fixture without losing grants, pages, drafts, or evidence", async () => {
    await inIsolatedSchema(async (client) => {
      await applyMigration(client, m0Migration);

      const organizationId = randomUUID();
      const adminId = randomUUID();
      const editorId = randomUUID();
      const inactiveId = randomUUID();
      const spaceId = randomUUID();
      const pageId = randomUUID();
      const draftId = randomUUID();
      const revisionId = randomUUID();
      const auditId = randomUUID();
      const outboxId = randomUUID();

      await client.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1, 'M0 upgrade fixture', $2)`,
        [organizationId, `upgrade-${organizationId}`],
      );
      await client.query(
        `INSERT INTO users
          (id, organization_id, email, display_name, password_hash, state)
         VALUES
          ($1, $4, $5, 'M0 Admin', 'unused', 'ACTIVE'),
          ($2, $4, $6, 'M1 Editor', 'unused', 'ACTIVE'),
          ($3, $4, $7, 'Inactive Member', 'unused', 'DEACTIVATED')`,
        [
          adminId,
          editorId,
          inactiveId,
          organizationId,
          `${adminId}@example.test`,
          `${editorId}@example.test`,
          `${inactiveId}@example.test`,
        ],
      );
      await client.query(
        `INSERT INTO memberships (organization_id, user_id, organization_role)
         VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER'), ($1, $4, 'MEMBER')`,
        [organizationId, adminId, editorId, inactiveId],
      );
      await client.query(
        `INSERT INTO spaces (id, organization_id, space_key, name, description)
         VALUES ($1, $2, 'MZERO', 'M0 Space', 'Preserve this space')`,
        [spaceId, organizationId],
      );
      await client.query(
        `INSERT INTO space_grants (organization_id, space_id, user_id, role)
         VALUES ($1, $2, $3, 'ADMIN')`,
        [organizationId, spaceId, adminId],
      );
      await client.query(
        `INSERT INTO pages
          (id, organization_id, space_id, title, slug, sibling_rank, created_by)
         VALUES ($1, $2, $3, 'Release guide', 'release-guide', 1024, $4)`,
        [pageId, organizationId, spaceId, adminId],
      );
      await client.query(
        `INSERT INTO drafts
          (id, organization_id, page_id, owner_id, title, body_json, schema_version)
         VALUES ($1, $2, $3, $4, 'Release guide', $5, 1)`,
        [
          draftId,
          organizationId,
          pageId,
          adminId,
          { type: "doc", schemaVersion: 1, content: [] },
        ],
      );
      await client.query(
        `INSERT INTO page_revisions
          (id, organization_id, page_id, number, author_id, title, body_json,
           body_text, schema_version, summary, idempotency_key, request_hash)
         VALUES ($1, $2, $3, 1, $4, 'Release guide', $5, '', 1,
                 'M0 publication', 'm0-publication', 'fixture-hash')`,
        [
          revisionId,
          organizationId,
          pageId,
          adminId,
          { type: "doc", schemaVersion: 1, content: [] },
        ],
      );
      await client.query(
        `UPDATE pages SET current_revision_id = $1 WHERE id = $2`,
        [revisionId, pageId],
      );
      await client.query(
        `INSERT INTO audit_events
          (id, organization_id, actor_id, action, target_type, target_id,
           safe_metadata, correlation_id)
         VALUES ($1, $2, $3, 'page.published', 'page', $4, '{}', 'm0-fixture')`,
        [auditId, organizationId, adminId, pageId],
      );
      await client.query(
        `INSERT INTO outbox_events
          (id, organization_id, topic, aggregate_id, payload)
         VALUES ($1, $2, 'page.published', $3, '{}')`,
        [outboxId, organizationId, pageId],
      );

      await applyMigration(client, m1Migration);
      await applyMigration(client, effectiveAccessMigration);
      await applyMigration(client, accessAdministrationMigration);

      await expect(
        client.query(
          `SELECT role FROM space_memberships
            WHERE organization_id = $1 AND space_id = $2 AND user_id = $3`,
          [organizationId, spaceId, adminId],
        ),
      ).resolves.toMatchObject({ rows: [{ role: "ADMIN" }] });
      const upgradedSpace = await client.query(
        `SELECT id, organization_id, space_key, name, description,
                version, membership_version
           FROM spaces WHERE id = $1`,
        [spaceId],
      );
      expect(upgradedSpace.rows[0]).toEqual({
        id: spaceId,
        organization_id: organizationId,
        space_key: "MZERO",
        name: "M0 Space",
        description: "Preserve this space",
        version: 1,
        membership_version: 1,
      });
      const upgradedPage = await client.query(
        `SELECT id, organization_id, space_id, current_revision_id,
                title, slug, sibling_rank, created_by
           FROM pages WHERE id = $1`,
        [pageId],
      );
      expect(upgradedPage.rows[0]).toEqual({
        id: pageId,
        organization_id: organizationId,
        space_id: spaceId,
        current_revision_id: revisionId,
        title: "Release guide",
        slug: "release-guide",
        sibling_rank: "1024.000000000000000",
        created_by: adminId,
      });
      const upgradedDraft = await client.query(
        `SELECT id, organization_id, page_id, principal_id, title, body_json
           FROM drafts WHERE id = $1`,
        [draftId],
      );
      expect(upgradedDraft.rows[0]).toEqual({
        id: draftId,
        organization_id: organizationId,
        page_id: pageId,
        principal_id: adminId,
        title: "Release guide",
        body_json: { type: "doc", schemaVersion: 1, content: [] },
      });
      await expect(
        client.query(
          `SELECT slug FROM page_aliases
            WHERE organization_id = $1 AND page_id = $2`,
          [organizationId, pageId],
        ),
      ).resolves.toMatchObject({ rows: [{ slug: "release-guide" }] });

      const preserved = await client.query<{
        audit_count: string;
        outbox_count: string;
        page_count: string;
        revision_count: string;
      }>(
        `SELECT
          (SELECT count(*) FROM pages WHERE id = $1) AS page_count,
          (SELECT count(*) FROM page_revisions WHERE id = $2) AS revision_count,
          (SELECT count(*) FROM audit_events WHERE id = $3) AS audit_count,
          (SELECT count(*) FROM outbox_events WHERE id = $4) AS outbox_count`,
        [pageId, revisionId, auditId, outboxId],
      );
      expect(preserved.rows[0]).toEqual({
        page_count: "1",
        revision_count: "1",
        audit_count: "1",
        outbox_count: "1",
      });

      await client.query(
        `INSERT INTO space_memberships
          (organization_id, space_id, user_id, role)
         VALUES ($1, $2, $3, 'EDITOR')`,
        [organizationId, spaceId, editorId],
      );
      await client.query(
        `INSERT INTO page_restrictions
          (organization_id, space_id, page_id, created_by)
         VALUES ($1, $2, $3, $4)`,
        [organizationId, spaceId, pageId, adminId],
      );
      await client.query(
        `INSERT INTO page_restriction_members
          (organization_id, space_id, page_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [organizationId, spaceId, pageId, editorId],
      );

      await client.query(
        `UPDATE users SET state = 'DEACTIVATED'
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, editorId],
      );
      await applyMigration(client, emergencyDeactivationMigration);

      const emergencyCleanup = await client.query<{
        grant_count: string;
        membership_version: number;
        membership_count: string;
        restriction_version: number;
      }>(
        `SELECT
          (SELECT count(*) FROM space_memberships
            WHERE organization_id = $1 AND space_id = $2 AND user_id = $3)
            AS membership_count,
          (SELECT count(*) FROM page_restriction_members
            WHERE organization_id = $1 AND space_id = $2 AND user_id = $3)
            AS grant_count,
          (SELECT membership_version FROM spaces WHERE id = $2)
            AS membership_version,
          (SELECT version FROM page_restrictions WHERE page_id = $4)
            AS restriction_version`,
        [organizationId, spaceId, editorId, pageId],
      );
      expect(emergencyCleanup.rows[0]).toEqual({
        grant_count: "0",
        membership_version: 2,
        membership_count: "0",
        restriction_version: 2,
      });

      await client.query(
        `UPDATE users SET state = 'ACTIVE'
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, editorId],
      );
      await expect(
        client.query(
          `SELECT role FROM space_memberships
            WHERE organization_id = $1 AND space_id = $2 AND user_id = $3`,
          [organizationId, spaceId, editorId],
        ),
      ).resolves.toMatchObject({ rows: [] });

      await expect(
        client.query(
          `INSERT INTO space_memberships
            (organization_id, space_id, user_id, role)
           VALUES ($1, $2, $3, 'VIEWER')`,
          [organizationId, spaceId, inactiveId],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await client.query(
        `INSERT INTO space_memberships
          (organization_id, space_id, user_id, role)
         VALUES ($1, $2, $3, 'EDITOR')`,
        [organizationId, spaceId, editorId],
      );
      await client.query(
        `INSERT INTO page_restriction_members
          (organization_id, space_id, page_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [organizationId, spaceId, pageId, editorId],
      );

      await client.query(
        `DELETE FROM space_memberships
          WHERE organization_id = $1 AND space_id = $2 AND user_id = $3`,
        [organizationId, spaceId, editorId],
      );
      const pruned = await client.query<{ count: string }>(
        `SELECT count(*)
           FROM page_restriction_members
          WHERE organization_id = $1 AND page_id = $2 AND user_id = $3`,
        [organizationId, pageId, editorId],
      );
      expect(pruned.rows[0]!.count).toBe("0");

      await client.query("BEGIN");
      try {
        await client.query(
          `DELETE FROM space_memberships
            WHERE organization_id = $1 AND space_id = $2 AND user_id = $3`,
          [organizationId, spaceId, adminId],
        );
        await expect(
          client.query("SET CONSTRAINTS ALL IMMEDIATE"),
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });
});
