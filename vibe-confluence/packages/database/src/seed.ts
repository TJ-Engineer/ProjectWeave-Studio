import { randomUUID } from "node:crypto";
import { hashPassword } from "@knowledge/domain";
import { closePool, inTransaction } from "./client";

async function seed(): Promise<void> {
  if (process.env.ENABLE_DEVELOPMENT_LOGIN !== "true") {
    throw new Error("Development seed requires ENABLE_DEVELOPMENT_LOGIN=true");
  }
  const email = process.env.DEMO_ADMIN_EMAIL?.trim().toLocaleLowerCase();
  const password = process.env.DEMO_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error(
      "DEMO_ADMIN_EMAIL and a 12+ character DEMO_ADMIN_PASSWORD are required",
    );
  }
  const organizationId = randomUUID();
  const userId = randomUUID();
  const passwordHash = await hashPassword(password);
  await inTransaction(async (client) => {
    const organization = await client.query<{ id: string }>(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'ProjectWeave', 'projectweave')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [organizationId],
    );
    const actualOrganizationId = organization.rows[0]!.id;
    const user = await client.query<{ id: string }>(
      `INSERT INTO users
        (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Knowledge Administrator', $4)
       ON CONFLICT (organization_id, email) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             password_hash = EXCLUDED.password_hash,
             state = 'ACTIVE'
       RETURNING id`,
      [userId, actualOrganizationId, email, passwordHash],
    );
    await client.query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')
       ON CONFLICT (organization_id, user_id) DO UPDATE
         SET organization_role = 'ADMIN'`,
      [actualOrganizationId, user.rows[0]!.id],
    );
  });
  console.log(`Seed complete. Sign in as ${email}.`);
}

seed()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
