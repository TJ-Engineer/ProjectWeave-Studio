import { randomUUID } from "node:crypto";
import { hashPassword } from "@vibe/domain";
import { closePool, getPool } from "./client";
import { createProject, getIdentity, listProjects } from "./repository";

async function seed(): Promise<void> {
  const email = (
    process.env.DEMO_ADMIN_EMAIL ?? "admin@vibe.local"
  ).toLowerCase();
  const password = process.env.DEMO_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error("DEMO_ADMIN_PASSWORD must contain at least 12 characters");
  }

  const pool = getPool();
  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE lower(email) = lower($1)",
    [email],
  );
  let userId = existing.rows[0]?.id;
  if (!userId) {
    const organizationId = randomUUID();
    userId = randomUUID();
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1, 'Vibe Engineering', 'vibe-engineering')`,
        [organizationId],
      );
      await client.query(
        `INSERT INTO users
          (id, organization_id, email, display_name, password_hash)
         VALUES ($1, $2, $3, 'Vibe Admin', $4)`,
        [userId, organizationId, email, passwordHash],
      );
      await client.query(
        `INSERT INTO memberships (organization_id, user_id, organization_role)
         VALUES ($1, $2, 'ADMIN')`,
        [organizationId, userId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const identity = await getIdentity(userId);
  if (!identity) throw new Error("Seeded user could not be loaded");
  const demoUsers = [
    {
      email: (
        process.env.DEMO_MEMBER_EMAIL ?? "member@vibe.local"
      ).toLowerCase(),
      displayName: "Vibe Member",
      password: process.env.DEMO_MEMBER_PASSWORD ?? password,
    },
    {
      email: (
        process.env.DEMO_VIEWER_EMAIL ?? "viewer@vibe.local"
      ).toLowerCase(),
      displayName: "Vibe Viewer",
      password: process.env.DEMO_VIEWER_PASSWORD ?? password,
    },
  ];
  for (const demoUser of demoUsers) {
    if (demoUser.password.length < 12) {
      throw new Error(
        `Password for ${demoUser.email} must contain 12 characters`,
      );
    }
    const existingDemoUser = await pool.query<{ id: string }>(
      `SELECT id FROM users
        WHERE organization_id = $1 AND lower(email) = lower($2)`,
      [identity.organizationId, demoUser.email],
    );
    const demoUserId = existingDemoUser.rows[0]?.id ?? randomUUID();
    if (!existingDemoUser.rows[0]) {
      await pool.query(
        `INSERT INTO users
          (id, organization_id, email, display_name, password_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          demoUserId,
          identity.organizationId,
          demoUser.email,
          demoUser.displayName,
          await hashPassword(demoUser.password),
        ],
      );
    }
    await pool.query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'MEMBER')
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [identity.organizationId, demoUserId],
    );
  }
  const projects = await listProjects(identity);
  if (projects.length === 0) {
    await createProject(identity, { key: "ENG", name: "Engineering" });
  }
  console.log(`Seed complete. Sign in as ${email}.`);
}

seed()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
