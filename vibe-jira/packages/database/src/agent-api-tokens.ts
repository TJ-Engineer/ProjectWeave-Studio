import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { UserIdentity } from "@vibe/contracts";
import { DomainError } from "@vibe/domain";
import type { PoolClient } from "pg";
import { getPool, inTransaction } from "./client";

const agentTokenMarker = "vibe_agent_";
const agentTokenPattern = /^vibe_agent_[A-Za-z0-9_-]{43}$/;

interface TokenUserRow {
  id: string;
  organization_id: string;
  email: string;
  display_name: string;
  organization_role: UserIdentity["organizationRole"];
}

export interface AgentApiTokenMetadata {
  id: string;
  organizationId: string;
  userId: string;
  userEmail: string;
  name: string;
  tokenPrefix: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreatedAgentApiToken extends AgentApiTokenMetadata {
  token: string;
}

export function generateAgentApiToken(): string {
  return `${agentTokenMarker}${randomBytes(32).toString("base64url")}`;
}

export function isAgentApiToken(value: string): boolean {
  return agentTokenPattern.test(value);
}

export function hashAgentApiToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function agentApiTokenFromAuthorization(
  authorization: string,
): string | null {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  const token = match?.[1];
  return token && isAgentApiToken(token) ? token : null;
}

async function resolveUser(
  client: PoolClient,
  email: string,
  organizationId?: string,
  activeOnly = true,
): Promise<TokenUserRow> {
  const result = await client.query<TokenUserRow>(
    `SELECT u.id, u.organization_id, u.email, u.display_name,
            m.organization_role
       FROM users u
       JOIN memberships m
         ON m.organization_id = u.organization_id AND m.user_id = u.id
      WHERE lower(u.email) = lower($1)
        AND ($2::uuid IS NULL OR u.organization_id = $2)
        AND ($3::boolean = false OR u.state = 'ACTIVE')
      ORDER BY u.organization_id
      LIMIT 2`,
    [email, organizationId ?? null, activeOnly],
  );
  if (result.rows.length === 0) {
    throw new DomainError(
      "AGENT_TOKEN_USER_NOT_FOUND",
      activeOnly
        ? "The active token user was not found"
        : "The token user was not found",
      404,
    );
  }
  if (result.rows.length > 1) {
    throw new DomainError(
      "AGENT_TOKEN_USER_AMBIGUOUS",
      "The email exists in multiple organizations; specify an organization ID",
      409,
    );
  }
  return result.rows[0]!;
}

function assertTokenAdministrator(
  actor: TokenUserRow,
  subject: TokenUserRow,
): void {
  if (actor.organization_id !== subject.organization_id) {
    throw new DomainError(
      "FORBIDDEN",
      "Token operators and users must belong to the same organization",
      403,
    );
  }
  if (actor.id !== subject.id && actor.organization_role !== "ADMIN") {
    throw new DomainError(
      "FORBIDDEN",
      "Only an organization administrator can manage another user's tokens",
      403,
    );
  }
}

function tokenMetadata(row: {
  id: string;
  organization_id: string;
  user_id: string;
  user_email: string;
  name: string;
  token_prefix: string;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}): AgentApiTokenMetadata {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    userEmail: row.user_email,
    name: row.name,
    tokenPrefix: row.token_prefix,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

async function recordTokenMutation(
  client: PoolClient,
  input: {
    actor: TokenUserRow;
    tokenId: string;
    action: "agent_token.created" | "agent_token.revoked";
    metadata: Record<string, unknown>;
    correlationId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id,
       metadata, correlation_id)
     VALUES ($1, $2, $3, $4, 'agent_api_token', $5, $6, $7)`,
    [
      randomUUID(),
      input.actor.organization_id,
      input.actor.id,
      input.action,
      input.tokenId,
      input.metadata,
      input.correlationId,
    ],
  );
  await client.query(
    `INSERT INTO outbox_events
      (id, organization_id, topic, aggregate_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomUUID(),
      input.actor.organization_id,
      input.action,
      input.tokenId,
      {
        tokenId: input.tokenId,
        actorId: input.actor.id,
        ...input.metadata,
        correlationId: input.correlationId,
      },
    ],
  );
}

export async function createAgentApiToken(input: {
  userEmail: string;
  actorEmail: string;
  organizationId?: string;
  name: string;
  expiresInDays?: number;
  correlationId?: string;
}): Promise<CreatedAgentApiToken> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) {
    throw new DomainError(
      "INVALID_AGENT_TOKEN_NAME",
      "Token names must contain 1-100 characters",
      400,
    );
  }
  const expiresInDays = input.expiresInDays ?? 90;
  if (
    !Number.isInteger(expiresInDays) ||
    expiresInDays < 1 ||
    expiresInDays > 365
  ) {
    throw new DomainError(
      "INVALID_AGENT_TOKEN_EXPIRY",
      "Token lifetime must be between 1 and 365 days",
      400,
    );
  }
  return inTransaction(async (client) => {
    const subject = await resolveUser(
      client,
      input.userEmail,
      input.organizationId,
    );
    const actor = await resolveUser(
      client,
      input.actorEmail,
      subject.organization_id,
    );
    assertTokenAdministrator(actor, subject);
    const id = randomUUID();
    const token = generateAgentApiToken();
    const tokenPrefix = token.slice(0, 22);
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
    const result = await client.query<{
      id: string;
      organization_id: string;
      user_id: string;
      user_email: string;
      name: string;
      token_prefix: string;
      expires_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
      created_at: Date;
    }>(
      `INSERT INTO agent_api_tokens
        (id, organization_id, user_id, name, token_hash, token_prefix, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, organization_id, user_id, $8::text AS user_email, name,
                 token_prefix, expires_at, last_used_at, revoked_at, created_at`,
      [
        id,
        subject.organization_id,
        subject.id,
        name,
        hashAgentApiToken(token),
        tokenPrefix,
        expiresAt,
        subject.email,
      ],
    );
    const correlationId = input.correlationId ?? randomUUID();
    await recordTokenMutation(client, {
      actor,
      tokenId: id,
      action: "agent_token.created",
      metadata: {
        userId: subject.id,
        name,
        tokenPrefix,
        expiresAt: expiresAt.toISOString(),
      },
      correlationId,
    });
    return { ...tokenMetadata(result.rows[0]!), token };
  });
}

export async function listAgentApiTokens(input: {
  userEmail: string;
  actorEmail: string;
  organizationId?: string;
}): Promise<AgentApiTokenMetadata[]> {
  const client = await getPool().connect();
  try {
    const subject = await resolveUser(
      client,
      input.userEmail,
      input.organizationId,
      false,
    );
    const actor = await resolveUser(
      client,
      input.actorEmail,
      subject.organization_id,
    );
    assertTokenAdministrator(actor, subject);
    const result = await client.query<{
      id: string;
      organization_id: string;
      user_id: string;
      user_email: string;
      name: string;
      token_prefix: string;
      expires_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
      created_at: Date;
    }>(
      `SELECT t.id, t.organization_id, t.user_id, u.email AS user_email,
              t.name, t.token_prefix, t.expires_at, t.last_used_at,
              t.revoked_at, t.created_at
         FROM agent_api_tokens t
         JOIN users u ON u.id = t.user_id AND u.organization_id = t.organization_id
        WHERE t.organization_id = $1 AND t.user_id = $2
        ORDER BY t.created_at DESC, t.id DESC`,
      [subject.organization_id, subject.id],
    );
    return result.rows.map(tokenMetadata);
  } finally {
    client.release();
  }
}

export async function revokeAgentApiToken(input: {
  tokenId: string;
  actorEmail: string;
  correlationId?: string;
}): Promise<AgentApiTokenMetadata> {
  return inTransaction(async (client) => {
    const existing = await client.query<{
      id: string;
      organization_id: string;
      user_id: string;
      user_email: string;
      name: string;
      token_prefix: string;
      expires_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
      created_at: Date;
    }>(
      `SELECT t.id, t.organization_id, t.user_id, u.email AS user_email,
              t.name, t.token_prefix, t.expires_at, t.last_used_at,
              t.revoked_at, t.created_at
         FROM agent_api_tokens t
         JOIN users u ON u.id = t.user_id AND u.organization_id = t.organization_id
        WHERE t.id = $1
        FOR UPDATE OF t`,
      [input.tokenId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new DomainError(
        "AGENT_TOKEN_NOT_FOUND",
        "The agent API token was not found",
        404,
      );
    }
    const actor = await resolveUser(
      client,
      input.actorEmail,
      row.organization_id,
    );
    const subject = await resolveUser(
      client,
      row.user_email,
      row.organization_id,
      false,
    );
    assertTokenAdministrator(actor, subject);
    if (!row.revoked_at) {
      const revoked = await client.query<{ revoked_at: Date }>(
        `UPDATE agent_api_tokens SET revoked_at = now()
          WHERE id = $1
          RETURNING revoked_at`,
        [row.id],
      );
      row.revoked_at = revoked.rows[0]!.revoked_at;
      await recordTokenMutation(client, {
        actor,
        tokenId: row.id,
        action: "agent_token.revoked",
        metadata: {
          userId: row.user_id,
          name: row.name,
          tokenPrefix: row.token_prefix,
        },
        correlationId: input.correlationId ?? randomUUID(),
      });
    }
    return tokenMetadata(row);
  });
}

export async function getIdentityByAgentApiToken(
  token: string,
): Promise<UserIdentity | null> {
  if (!isAgentApiToken(token)) return null;
  const result = await getPool().query<TokenUserRow & { token_id: string }>(
    `SELECT t.id AS token_id, u.id, u.organization_id, u.email,
            u.display_name, m.organization_role
       FROM agent_api_tokens t
       JOIN users u ON u.id = t.user_id AND u.organization_id = t.organization_id
       JOIN memberships m
         ON m.organization_id = u.organization_id AND m.user_id = u.id
      WHERE t.token_hash = $1
        AND t.revoked_at IS NULL
        AND t.expires_at > now()
        AND u.state = 'ACTIVE'`,
    [hashAgentApiToken(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  await getPool().query(
    `UPDATE agent_api_tokens SET last_used_at = now()
      WHERE id = $1
        AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
    [row.token_id],
  );
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    displayName: row.display_name,
    organizationRole: row.organization_role,
  };
}
