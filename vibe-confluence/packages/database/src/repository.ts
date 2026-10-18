import { createHash, randomUUID } from "node:crypto";
import {
  documentNodeSchema,
  emptyDocument,
  type DocumentNode,
  type DraftView,
  type PageSummary,
  type PageWorkspace,
  type RevisionView,
  type SpaceRole,
  type SpaceSummary,
  type UserIdentity,
} from "@knowledge/contracts";
import {
  assertCapability,
  assertVersion,
  diffDocuments,
  documentToPlainText,
  DomainError,
  slugify,
  verifyPassword,
} from "@knowledge/domain";
import type { PoolClient, QueryResultRow } from "pg";
import { getPool, inTransaction } from "./client";

interface IdentityRow extends QueryResultRow {
  id: string;
  organization_id: string;
  email: string;
  display_name: string;
  organization_role: "ADMIN" | "MEMBER";
  state: "ACTIVE" | "DEACTIVATED";
  password_hash: string;
}

interface SpaceRow extends QueryResultRow {
  id: string;
  organization_id: string;
  space_key: string;
  name: string;
  description: string;
  role: SpaceRole | null;
  version: number;
}

interface PageRow extends QueryResultRow {
  id: string;
  organization_id: string;
  space_id: string;
  parent_id: string | null;
  current_revision_id: string | null;
  title: string;
  slug: string;
  version: number;
  created_by: string;
}

interface DraftRow extends QueryResultRow {
  id: string;
  title: string;
  body_json: unknown;
  base_revision_id: string | null;
  version: number;
  saved_at: Date;
}

interface RevisionRow extends QueryResultRow {
  id: string;
  number: number;
  title: string;
  body_json: unknown;
  body_text: string;
  summary: string;
  author_name: string;
  created_at: Date;
  request_hash?: string;
}

function identityFromRow(row: IdentityRow): UserIdentity {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    displayName: row.display_name,
    organizationRole: row.organization_role,
  };
}

function spaceFromRow(row: SpaceRow, identity: UserIdentity): SpaceSummary {
  return {
    id: row.id,
    key: row.space_key,
    name: row.name,
    description: row.description,
    role:
      identity.organizationRole === "ADMIN" ? "ADMIN" : (row.role ?? "VIEWER"),
    version: row.version,
  };
}

function pageFromRow(row: PageRow): PageSummary {
  return {
    id: row.id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    title: row.title,
    slug: row.slug,
    currentRevisionId: row.current_revision_id,
    version: row.version,
  };
}

function draftFromRow(row: DraftRow): DraftView {
  return {
    id: row.id,
    title: row.title,
    document: documentNodeSchema.parse(row.body_json),
    baseRevisionId: row.base_revision_id,
    version: row.version,
    savedAt: row.saved_at.toISOString(),
  };
}

function revisionFromRow(row: RevisionRow): RevisionView {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    document: documentNodeSchema.parse(row.body_json),
    plainText: row.body_text,
    summary: row.summary,
    authorName: row.author_name,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getIdentity(
  userId: string,
): Promise<UserIdentity | null> {
  const result = await getPool().query<IdentityRow>(
    `SELECT u.id, u.organization_id, u.email, u.display_name, u.state,
            u.password_hash, m.organization_role
       FROM users u
       JOIN memberships m ON m.organization_id = u.organization_id
                         AND m.user_id = u.id
      WHERE u.id = $1 AND u.state = 'ACTIVE'`,
    [userId],
  );
  return result.rows[0] ? identityFromRow(result.rows[0]) : null;
}

export async function authenticateDevelopmentUser(
  email: string,
  password: string,
): Promise<UserIdentity | null> {
  if (process.env.ENABLE_DEVELOPMENT_LOGIN !== "true") return null;
  const result = await getPool().query<IdentityRow>(
    `SELECT u.id, u.organization_id, u.email, u.display_name, u.state,
            u.password_hash, m.organization_role
       FROM users u
       JOIN memberships m ON m.organization_id = u.organization_id
                         AND m.user_id = u.id
      WHERE lower(u.email) = lower($1) AND u.state = 'ACTIVE'
      LIMIT 1`,
    [email],
  );
  const row = result.rows[0];
  if (!row || !(await verifyPassword(password, row.password_hash))) return null;
  return identityFromRow(row);
}

async function querySpace(
  identity: UserIdentity,
  keyOrId: string,
  client: Pick<PoolClient, "query"> = getPool(),
): Promise<SpaceRow | null> {
  const result = await client.query<SpaceRow>(
    `SELECT s.id, s.organization_id, s.space_key, s.name, s.description,
            s.version, g.role
       FROM spaces s
       LEFT JOIN space_memberships g ON g.organization_id = s.organization_id
                               AND g.space_id = s.id
                               AND g.user_id = $2
      WHERE s.organization_id = $1
        AND (s.space_key = $3 OR s.id::text = $3)
        AND s.archived_at IS NULL
        AND ($4 = 'ADMIN' OR g.user_id IS NOT NULL)`,
    [identity.organizationId, identity.id, keyOrId, identity.organizationRole],
  );
  return result.rows[0] ?? null;
}

export async function listSpaces(
  identity: UserIdentity,
): Promise<SpaceSummary[]> {
  const result = await getPool().query<SpaceRow>(
    `SELECT s.id, s.organization_id, s.space_key, s.name, s.description,
            s.version, g.role
       FROM spaces s
       LEFT JOIN space_memberships g ON g.organization_id = s.organization_id
                               AND g.space_id = s.id
                               AND g.user_id = $2
      WHERE s.organization_id = $1 AND s.archived_at IS NULL
        AND ($3 = 'ADMIN' OR g.user_id IS NOT NULL)
      ORDER BY s.name, s.id`,
    [identity.organizationId, identity.id, identity.organizationRole],
  );
  return result.rows.map((row) => spaceFromRow(row, identity));
}

export async function createSpace(
  identity: UserIdentity,
  input: { key: string; name: string; description: string },
  correlationId: string,
): Promise<SpaceSummary> {
  assertCapability(identity.organizationRole, null, "space:create");
  return inTransaction(async (client) => {
    const id = randomUUID();
    const result = await client.query<SpaceRow>(
      `INSERT INTO spaces (id, organization_id, space_key, name, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, organization_id, space_key, name, description, version,
                 'ADMIN'::text AS role`,
      [id, identity.organizationId, input.key, input.name, input.description],
    );
    await client.query(
      `INSERT INTO space_memberships (organization_id, space_id, user_id, role)
       VALUES ($1, $2, $3, 'ADMIN')`,
      [identity.organizationId, id, identity.id],
    );
    await recordEffects(
      client,
      identity,
      "space.created",
      "space",
      id,
      correlationId,
      {
        key: input.key,
      },
    );
    return spaceFromRow(result.rows[0]!, identity);
  });
}

export async function listPages(
  identity: UserIdentity,
  spaceKey: string,
): Promise<{ space: SpaceSummary; pages: PageSummary[] }> {
  const space = await querySpace(identity, spaceKey);
  if (!space) throw new DomainError("NOT_FOUND", "Space not found", 404);
  assertCapability(identity.organizationRole, space.role, "page:view");
  const result = await getPool().query<PageRow>(
    `SELECT id, organization_id, space_id, parent_id, current_revision_id,
            CASE WHEN current_revision_id IS NULL
                 THEN COALESCE((SELECT d.title FROM drafts d
                                  WHERE d.page_id = pages.id AND d.principal_id = $3),
                               'Untitled draft')
                 ELSE title END AS title,
            slug, version, created_by
       FROM pages
      WHERE organization_id = $1 AND space_id = $2 AND state = 'ACTIVE'
        AND (current_revision_id IS NOT NULL OR created_by = $3)
      ORDER BY sibling_rank, id`,
    [identity.organizationId, space.id, identity.id],
  );
  return {
    space: spaceFromRow(space, identity),
    pages: result.rows.map(pageFromRow),
  };
}

export async function createPage(
  identity: UserIdentity,
  spaceKey: string,
  input: { title: string; parentId: string | null },
  correlationId: string,
): Promise<PageSummary> {
  return inTransaction(async (client) => {
    const space = await querySpace(identity, spaceKey, client);
    if (!space) throw new DomainError("NOT_FOUND", "Space not found", 404);
    assertCapability(identity.organizationRole, space.role, "page:create");
    if (input.parentId) {
      const parent = await client.query(
        `SELECT 1 FROM pages
          WHERE organization_id = $1 AND space_id = $2 AND id = $3
            AND state = 'ACTIVE'`,
        [identity.organizationId, space.id, input.parentId],
      );
      if (!parent.rowCount) {
        throw new DomainError(
          "INVALID_PARENT",
          "Parent page not found in this space",
          400,
        );
      }
    }
    const rank = await client.query<{ next_rank: string }>(
      `SELECT COALESCE(MAX(sibling_rank), 0) + 1024 AS next_rank
         FROM pages
        WHERE organization_id = $1 AND space_id = $2
          AND parent_id IS NOT DISTINCT FROM $3`,
      [identity.organizationId, space.id, input.parentId],
    );
    const id = randomUUID();
    const pageResult = await client.query<PageRow>(
      `INSERT INTO pages
        (id, organization_id, space_id, parent_id, title, slug, sibling_rank, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, organization_id, space_id, parent_id, current_revision_id,
                 title, slug, version, created_by`,
      [
        id,
        identity.organizationId,
        space.id,
        input.parentId,
        "Untitled draft",
        await uniqueSlug(client, space.id, input.title),
        rank.rows[0]!.next_rank,
        identity.id,
      ],
    );
    await client.query(
      `INSERT INTO drafts
        (id, organization_id, page_id, principal_id, title, body_json, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [
        randomUUID(),
        identity.organizationId,
        id,
        identity.id,
        input.title,
        emptyDocument,
      ],
    );
    await client.query(
      `INSERT INTO page_aliases (organization_id, space_id, page_id, slug)
       VALUES ($1, $2, $3, $4)`,
      [identity.organizationId, space.id, id, pageResult.rows[0]!.slug],
    );
    await recordEffects(
      client,
      identity,
      "page.created",
      "page",
      id,
      correlationId,
      {
        spaceId: space.id,
        parentId: input.parentId,
      },
    );
    return { ...pageFromRow(pageResult.rows[0]!), title: input.title };
  });
}

async function uniqueSlug(
  client: Pick<PoolClient, "query">,
  spaceId: string,
  title: string,
): Promise<string> {
  const base = slugify(title);
  const result = await client.query<{ slug: string }>(
    `SELECT slug
       FROM page_aliases
      WHERE space_id = $1 AND (slug = $2 OR slug LIKE $3)
      UNION
     SELECT slug
       FROM pages
      WHERE space_id = $1 AND (slug = $2 OR slug LIKE $3)`,
    [spaceId, base, `${base}-%`],
  );
  const used = new Set(result.rows.map((row) => row.slug));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

async function pageAccess(
  identity: UserIdentity,
  pageId: string,
  client: Pick<PoolClient, "query"> = getPool(),
  lock = false,
): Promise<{ page: PageRow; space: SpaceRow } | null> {
  const result = await client.query<PageRow & SpaceRow>(
    `SELECT p.id, p.organization_id, p.space_id, p.parent_id,
            p.current_revision_id, p.title, p.slug, p.version, p.created_by,
            s.space_key, s.name, s.description, s.version AS space_version,
            g.role
       FROM pages p
       JOIN spaces s ON s.organization_id = p.organization_id AND s.id = p.space_id
       LEFT JOIN space_memberships g ON g.organization_id = p.organization_id
                               AND g.space_id = p.space_id AND g.user_id = $2
      WHERE p.organization_id = $1 AND p.id = $3 AND p.state = 'ACTIVE'
        AND s.archived_at IS NULL
        AND ($4 = 'ADMIN' OR g.user_id IS NOT NULL)
      ${lock ? "FOR UPDATE OF p" : ""}`,
    [identity.organizationId, identity.id, pageId, identity.organizationRole],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    page: row,
    space: {
      ...row,
      id: row.space_id,
      version: Number(
        (row as unknown as { space_version: number }).space_version,
      ),
    },
  };
}

async function revisionsForPage(
  identity: UserIdentity,
  pageId: string,
  client: Pick<PoolClient, "query"> = getPool(),
): Promise<RevisionView[]> {
  const result = await client.query<RevisionRow>(
    `SELECT r.id, r.number, r.title, r.body_json, r.body_text, r.summary,
            u.display_name AS author_name, r.created_at
       FROM page_revisions r
       JOIN users u ON u.organization_id = r.organization_id AND u.id = r.author_id
      WHERE r.organization_id = $1 AND r.page_id = $2
      ORDER BY r.number DESC`,
    [identity.organizationId, pageId],
  );
  return result.rows.map(revisionFromRow);
}

export async function getPageWorkspace(
  identity: UserIdentity,
  pageId: string,
): Promise<PageWorkspace> {
  const access = await pageAccess(identity, pageId);
  if (!access) throw new DomainError("NOT_FOUND", "Page not found", 404);
  assertCapability(identity.organizationRole, access.space.role, "page:edit");
  if (
    !access.page.current_revision_id &&
    access.page.created_by !== identity.id
  ) {
    throw new DomainError("NOT_FOUND", "Page not found", 404);
  }
  const draftResult = await getPool().query<DraftRow>(
    `SELECT id, title, body_json, base_revision_id, version, saved_at
       FROM drafts
      WHERE organization_id = $1 AND page_id = $2 AND principal_id = $3`,
    [identity.organizationId, pageId, identity.id],
  );
  let draft = draftResult.rows[0];
  if (!draft) {
    const current = access.page.current_revision_id
      ? await getPool().query<RevisionRow>(
          `SELECT r.id, r.number, r.title, r.body_json, r.body_text, r.summary,
                  u.display_name AS author_name, r.created_at
             FROM page_revisions r
             JOIN users u ON u.organization_id = r.organization_id AND u.id = r.author_id
            WHERE r.organization_id = $1 AND r.id = $2`,
          [identity.organizationId, access.page.current_revision_id],
        )
      : null;
    const source = current?.rows[0];
    const inserted = await getPool().query<DraftRow>(
      `INSERT INTO drafts
        (id, organization_id, page_id, principal_id, base_revision_id, title,
         body_json, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       ON CONFLICT (page_id, principal_id) DO UPDATE SET page_id = EXCLUDED.page_id
       RETURNING id, title, body_json, base_revision_id, version, saved_at`,
      [
        randomUUID(),
        identity.organizationId,
        pageId,
        identity.id,
        source?.id ?? null,
        source?.title ?? access.page.title,
        source ? documentNodeSchema.parse(source.body_json) : emptyDocument,
      ],
    );
    draft = inserted.rows[0];
  }
  if (!draft) throw new Error("Draft creation failed");
  return {
    page: pageFromRow(access.page),
    space: spaceFromRow(access.space, identity),
    draft: draftFromRow(draft),
    revisions: await revisionsForPage(identity, pageId),
  };
}

export async function saveDraft(
  identity: UserIdentity,
  pageId: string,
  input: {
    title: string;
    document: DocumentNode;
    baseRevisionId: string | null;
    version: number;
  },
): Promise<DraftView> {
  const access = await pageAccess(identity, pageId);
  if (!access) throw new DomainError("NOT_FOUND", "Page not found", 404);
  assertCapability(identity.organizationRole, access.space.role, "page:edit");
  const result = await getPool().query<DraftRow>(
    `UPDATE drafts
        SET title = $4, body_json = $5, schema_version = 1,
            version = version + 1, saved_at = now()
      WHERE organization_id = $1 AND page_id = $2 AND principal_id = $3
        AND version = $6 AND base_revision_id IS NOT DISTINCT FROM $7
      RETURNING id, title, body_json, base_revision_id, version, saved_at`,
    [
      identity.organizationId,
      pageId,
      identity.id,
      input.title,
      input.document,
      input.version,
      input.baseRevisionId,
    ],
  );
  if (!result.rows[0]) {
    const current = await getPool().query<{ version: number }>(
      `SELECT version FROM drafts
        WHERE organization_id = $1 AND page_id = $2 AND principal_id = $3`,
      [identity.organizationId, pageId, identity.id],
    );
    if (!current.rows[0])
      throw new DomainError("NOT_FOUND", "Draft not found", 404);
    assertVersion(input.version, current.rows[0].version);
    throw new DomainError(
      "DRAFT_BASE_CHANGED",
      "This draft is based on a different published revision. Refresh before saving.",
      409,
    );
  }
  return draftFromRow(result.rows[0]);
}

export async function publishPage(
  identity: UserIdentity,
  pageId: string,
  input: {
    title: string;
    document: DocumentNode;
    baseRevisionId: string | null;
    version: number;
    summary: string;
  },
  idempotencyKey: string,
  correlationId: string,
): Promise<RevisionView> {
  return inTransaction(async (client) => {
    const mutationHash = hashMutation(input);
    const prior = await revisionByIdempotency(
      client,
      identity,
      pageId,
      idempotencyKey,
    );
    if (prior) {
      if (prior.requestHash !== mutationHash) {
        throw new DomainError(
          "IDEMPOTENCY_KEY_REUSED",
          "That idempotency key was already used for a different publication",
          409,
        );
      }
      return prior.revision;
    }
    const access = await pageAccess(identity, pageId, client, true);
    if (!access) throw new DomainError("NOT_FOUND", "Page not found", 404);
    assertCapability(
      identity.organizationRole,
      access.space.role,
      "page:publish",
    );
    if (access.page.current_revision_id !== input.baseRevisionId) {
      throw new DomainError(
        "PUBLICATION_CONFLICT",
        "Another revision was published. Compare or refresh before publishing.",
        409,
      );
    }
    const draftResult = await client.query<DraftRow>(
      `SELECT id, title, body_json, base_revision_id, version, saved_at
         FROM drafts
        WHERE organization_id = $1 AND page_id = $2 AND principal_id = $3
        FOR UPDATE`,
      [identity.organizationId, pageId, identity.id],
    );
    const draft = draftResult.rows[0];
    if (!draft) throw new DomainError("NOT_FOUND", "Draft not found", 404);
    assertVersion(input.version, draft.version);
    if (draft.base_revision_id !== input.baseRevisionId) {
      throw new DomainError(
        "DRAFT_BASE_CHANGED",
        "Refresh the draft before publishing.",
        409,
      );
    }
    const next = await client.query<{ next_number: number }>(
      `SELECT COALESCE(MAX(number), 0) + 1 AS next_number
         FROM page_revisions WHERE organization_id = $1 AND page_id = $2`,
      [identity.organizationId, pageId],
    );
    const revisionId = randomUUID();
    const inserted = await client.query<RevisionRow>(
      `INSERT INTO page_revisions
        (id, organization_id, page_id, number, author_id, title, body_json,
         body_text, schema_version, summary, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11)
       RETURNING id, number, title, body_json, body_text, summary,
                 $12::text AS author_name, created_at`,
      [
        revisionId,
        identity.organizationId,
        pageId,
        next.rows[0]!.next_number,
        identity.id,
        input.title,
        input.document,
        documentToPlainText(input.document),
        input.summary,
        idempotencyKey,
        mutationHash,
        identity.displayName,
      ],
    );
    await client.query(
      `UPDATE pages
          SET current_revision_id = $3, title = $4, version = version + 1,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [identity.organizationId, pageId, revisionId, input.title],
    );
    await client.query(
      `UPDATE drafts
          SET base_revision_id = $4, title = $5, body_json = $6,
              version = version + 1, saved_at = now()
        WHERE organization_id = $1 AND page_id = $2 AND principal_id = $3`,
      [
        identity.organizationId,
        pageId,
        identity.id,
        revisionId,
        input.title,
        input.document,
      ],
    );
    await recordEffects(
      client,
      identity,
      "page.published",
      "page",
      pageId,
      correlationId,
      { revisionId, revisionNumber: next.rows[0]!.next_number },
    );
    return revisionFromRow(inserted.rows[0]!);
  });
}

async function revisionByIdempotency(
  client: Pick<PoolClient, "query">,
  identity: UserIdentity,
  pageId: string,
  key: string,
): Promise<{ revision: RevisionView; requestHash: string } | null> {
  const result = await client.query<RevisionRow>(
    `SELECT r.id, r.number, r.title, r.body_json, r.body_text, r.summary,
            u.display_name AS author_name, r.created_at, r.request_hash
       FROM page_revisions r
       JOIN users u ON u.organization_id = r.organization_id AND u.id = r.author_id
      WHERE r.organization_id = $1 AND r.page_id = $2
        AND r.author_id = $3 AND r.idempotency_key = $4`,
    [identity.organizationId, pageId, identity.id, key],
  );
  return result.rows[0]
    ? {
        revision: revisionFromRow(result.rows[0]),
        requestHash: result.rows[0].request_hash ?? "",
      }
    : null;
}

function hashMutation(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function listRevisions(
  identity: UserIdentity,
  pageId: string,
): Promise<RevisionView[]> {
  const access = await pageAccess(identity, pageId);
  if (!access) throw new DomainError("NOT_FOUND", "Page not found", 404);
  assertCapability(identity.organizationRole, access.space.role, "page:view");
  return revisionsForPage(identity, pageId);
}

export async function compareRevision(
  identity: UserIdentity,
  pageId: string,
  number: number,
): Promise<{
  from: number | null;
  to: number;
  lines: ReturnType<typeof diffDocuments>;
}> {
  const revisions = await listRevisions(identity, pageId);
  const target = revisions.find((revision) => revision.number === number);
  if (!target) throw new DomainError("NOT_FOUND", "Revision not found", 404);
  const previous = revisions.find((revision) => revision.number === number - 1);
  return {
    from: previous?.number ?? null,
    to: target.number,
    lines: diffDocuments(previous?.document ?? emptyDocument, target.document),
  };
}

export async function restoreRevision(
  identity: UserIdentity,
  pageId: string,
  revisionNumber: number,
  input: { expectedHeadRevisionId: string | null; summary: string },
  idempotencyKey: string,
  correlationId: string,
): Promise<RevisionView> {
  return inTransaction(async (client) => {
    const mutationHash = hashMutation({ revisionNumber, ...input });
    const prior = await revisionByIdempotency(
      client,
      identity,
      pageId,
      idempotencyKey,
    );
    if (prior) {
      if (prior.requestHash !== mutationHash) {
        throw new DomainError(
          "IDEMPOTENCY_KEY_REUSED",
          "That idempotency key was already used for a different restore",
          409,
        );
      }
      return prior.revision;
    }
    const access = await pageAccess(identity, pageId, client, true);
    if (!access) throw new DomainError("NOT_FOUND", "Page not found", 404);
    assertCapability(
      identity.organizationRole,
      access.space.role,
      "page:restore",
    );
    if (access.page.current_revision_id !== input.expectedHeadRevisionId) {
      throw new DomainError(
        "PUBLICATION_CONFLICT",
        "The page changed before restore.",
        409,
      );
    }
    const sourceResult = await client.query<RevisionRow>(
      `SELECT r.id, r.number, r.title, r.body_json, r.body_text, r.summary,
              u.display_name AS author_name, r.created_at
         FROM page_revisions r
         JOIN users u ON u.organization_id = r.organization_id AND u.id = r.author_id
        WHERE r.organization_id = $1 AND r.page_id = $2 AND r.number = $3`,
      [identity.organizationId, pageId, revisionNumber],
    );
    const source = sourceResult.rows[0];
    if (!source) throw new DomainError("NOT_FOUND", "Revision not found", 404);
    const next = await client.query<{ next_number: number }>(
      `SELECT COALESCE(MAX(number), 0) + 1 AS next_number
         FROM page_revisions WHERE organization_id = $1 AND page_id = $2`,
      [identity.organizationId, pageId],
    );
    const revisionId = randomUUID();
    const inserted = await client.query<RevisionRow>(
      `INSERT INTO page_revisions
        (id, organization_id, page_id, number, author_id, title, body_json,
         body_text, schema_version, summary, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11)
       RETURNING id, number, title, body_json, body_text, summary,
                 $12::text AS author_name, created_at`,
      [
        revisionId,
        identity.organizationId,
        pageId,
        next.rows[0]!.next_number,
        identity.id,
        source.title,
        source.body_json,
        source.body_text,
        input.summary || `Restored revision ${revisionNumber}`,
        idempotencyKey,
        mutationHash,
        identity.displayName,
      ],
    );
    await client.query(
      `UPDATE pages
          SET current_revision_id = $3, title = $4, version = version + 1,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [identity.organizationId, pageId, revisionId, source.title],
    );
    await client.query(
      `INSERT INTO drafts
        (id, organization_id, page_id, principal_id, base_revision_id, title,
         body_json, schema_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       ON CONFLICT (page_id, principal_id) DO UPDATE
         SET base_revision_id = EXCLUDED.base_revision_id,
             title = EXCLUDED.title, body_json = EXCLUDED.body_json,
             version = drafts.version + 1, saved_at = now()`,
      [
        randomUUID(),
        identity.organizationId,
        pageId,
        identity.id,
        revisionId,
        source.title,
        source.body_json,
      ],
    );
    await recordEffects(
      client,
      identity,
      "page.revision_restored",
      "page",
      pageId,
      correlationId,
      {
        sourceRevision: revisionNumber,
        revisionId,
        revisionNumber: next.rows[0]!.next_number,
      },
    );
    return revisionFromRow(inserted.rows[0]!);
  });
}

async function recordEffects(
  client: Pick<PoolClient, "query">,
  identity: UserIdentity,
  action: string,
  targetType: string,
  targetId: string,
  correlationId: string,
  safeMetadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id,
       safe_metadata, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      identity.organizationId,
      identity.id,
      action,
      targetType,
      targetId,
      safeMetadata,
      correlationId,
    ],
  );
  await client.query(
    `INSERT INTO outbox_events
      (id, organization_id, topic, aggregate_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), identity.organizationId, action, targetId, safeMetadata],
  );
}
