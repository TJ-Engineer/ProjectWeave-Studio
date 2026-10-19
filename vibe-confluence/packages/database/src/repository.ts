import { createHash, randomUUID } from "node:crypto";
import {
  documentNodeSchema,
  emptyDocument,
  type DocumentNode,
  type DraftView,
  type MembershipMutationResult,
  type MovePageResult,
  type OrganizationMemberCandidate,
  type PageAliasResolution,
  type PageBreadcrumb,
  type PageLifecycleResult,
  type PageRestrictionAdministration,
  type PageSummary,
  type PageTreeNode,
  type PageTreePage,
  type PageWorkspace,
  type PublishedPageView,
  type RevisionView,
  type SpaceMemberPage,
  type SpaceMemberView,
  type SpaceRole,
  type SpaceSummary,
  type UserIdentity,
} from "@knowledge/contracts";
import {
  assertCapability,
  assertVersion,
  can,
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
  membership_version: number;
}

interface PageRow extends QueryResultRow {
  id: string;
  organization_id: string;
  space_id: string;
  parent_id: string | null;
  current_revision_id: string | null;
  title: string;
  slug: string;
  sibling_rank: string;
  state: "ACTIVE" | "ARCHIVED" | "TRASHED";
  lifecycle_root_id: string | null;
  lifecycle_before_page_id: string | null;
  lifecycle_after_page_id: string | null;
  version: number;
  created_by: string;
}

interface LifecycleSubtreeRow extends PageRow {
  published: boolean;
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

interface SpaceMemberRow extends QueryResultRow {
  user_id: string;
  display_name: string;
  email: string;
  role: SpaceRole;
  unpublished_page_count: number;
  page_grant_count: number;
}

interface OrganizationMemberCandidateRow extends QueryResultRow {
  user_id: string;
  display_name: string;
  email: string;
}

interface PageRestrictionRow extends QueryResultRow {
  version: number;
  enabled: boolean;
}

interface PageTreeRow extends PageRow {
  has_children: boolean;
}

interface SiblingListRow extends QueryResultRow {
  parent_id: string | null;
  version: number;
}

interface SiblingPageRow extends QueryResultRow {
  id: string;
  sibling_rank: string;
}

interface HierarchyMemberAccessRow extends QueryResultRow {
  user_id: string;
  old_allowed: boolean;
  future_allowed: boolean;
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
    state: row.state,
    currentRevisionId: row.current_revision_id,
    version: row.version,
  };
}

function pageTreeFromRow(row: PageTreeRow): PageTreeNode {
  return { ...pageFromRow(row), hasChildren: row.has_children };
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

function spaceMemberFromRow(row: SpaceMemberRow): SpaceMemberView {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    unpublishedPageCount: Number(row.unpublished_page_count),
    pageGrantCount: Number(row.page_grant_count),
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
  lock = false,
): Promise<SpaceRow | null> {
  const result = await client.query<SpaceRow>(
    `SELECT s.id, s.organization_id, s.space_key, s.name, s.description,
            s.version, s.membership_version, g.role
       FROM spaces s
       LEFT JOIN space_memberships g ON g.organization_id = s.organization_id
                               AND g.space_id = s.id
                               AND g.user_id = $2
      WHERE s.organization_id = $1
        AND (s.space_key = $3 OR s.id::text = $3)
        AND s.archived_at IS NULL
        AND ($4 = 'ADMIN' OR g.user_id IS NOT NULL)
      ${lock ? "FOR UPDATE OF s" : ""}`,
    [identity.organizationId, identity.id, keyOrId, identity.organizationRole],
  );
  return result.rows[0] ?? null;
}

export async function listSpaces(
  identity: UserIdentity,
): Promise<SpaceSummary[]> {
  const result = await getPool().query<SpaceRow>(
    `SELECT s.id, s.organization_id, s.space_key, s.name, s.description,
            s.version, s.membership_version, g.role
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
                 membership_version, 'ADMIN'::text AS role`,
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

export async function listSpaceMembers(
  identity: UserIdentity,
  spaceKey: string,
  input: {
    kind: "members" | "candidates";
    query: string;
    cursor: string | null;
    limit: number;
  },
): Promise<SpaceMemberPage> {
  const space = await querySpace(identity, spaceKey);
  if (!space) throw new DomainError("NOT_FOUND", "Space not found", 404);
  assertCapability(identity.organizationRole, space.role, "space:admin");
  const requestedLimit = input.limit + 1;
  if (input.kind === "candidates") {
    const result = await getPool().query<OrganizationMemberCandidateRow>(
      `SELECT u.id AS user_id, u.display_name, u.email
         FROM users u
         JOIN memberships organization_member
           ON organization_member.organization_id = u.organization_id
          AND organization_member.user_id = u.id
        WHERE u.organization_id = $1
          AND u.state = 'ACTIVE'
          AND NOT EXISTS (
            SELECT 1
              FROM space_memberships space_member
             WHERE space_member.organization_id = u.organization_id
               AND space_member.space_id = $2
               AND space_member.user_id = u.id
          )
          AND (
            $3 = ''
            OR u.display_name ILIKE '%' || $3 || '%'
            OR u.email ILIKE '%' || $3 || '%'
          )
          AND ($4::uuid IS NULL OR u.id > $4)
        ORDER BY u.id
        LIMIT $5`,
      [
        identity.organizationId,
        space.id,
        input.query,
        input.cursor,
        requestedLimit,
      ],
    );
    const hasNext = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    const items: OrganizationMemberCandidate[] = rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
    }));
    return {
      space: spaceFromRow(space, identity),
      membershipVersion: space.membership_version,
      kind: input.kind,
      items,
      nextCursor: hasNext ? (rows.at(-1)?.user_id ?? null) : null,
    };
  }

  const result = await getPool().query<SpaceMemberRow>(
    `SELECT space_member.user_id, u.display_name, u.email, space_member.role,
            (
              SELECT count(*)::integer
                FROM pages owned_page
               WHERE owned_page.organization_id = space_member.organization_id
                 AND owned_page.space_id = space_member.space_id
                 AND owned_page.created_by = space_member.user_id
                 AND owned_page.current_revision_id IS NULL
                 AND owned_page.state = 'ACTIVE'
            ) AS unpublished_page_count,
            (
              SELECT count(*)::integer
                FROM page_restriction_members restriction_member
               WHERE restriction_member.organization_id = space_member.organization_id
                 AND restriction_member.space_id = space_member.space_id
                 AND restriction_member.user_id = space_member.user_id
            ) AS page_grant_count
       FROM space_memberships space_member
       JOIN users u
         ON u.organization_id = space_member.organization_id
        AND u.id = space_member.user_id
      WHERE space_member.organization_id = $1
        AND space_member.space_id = $2
        AND (
          $3 = ''
          OR u.display_name ILIKE '%' || $3 || '%'
          OR u.email ILIKE '%' || $3 || '%'
        )
        AND ($4::uuid IS NULL OR space_member.user_id > $4)
      ORDER BY space_member.user_id
      LIMIT $5`,
    [
      identity.organizationId,
      space.id,
      input.query,
      input.cursor,
      requestedLimit,
    ],
  );
  const hasNext = result.rows.length > input.limit;
  const rows = result.rows.slice(0, input.limit);
  return {
    space: spaceFromRow(space, identity),
    membershipVersion: space.membership_version,
    kind: input.kind,
    items: rows.map(spaceMemberFromRow),
    nextCursor: hasNext ? (rows.at(-1)?.user_id ?? null) : null,
  };
}

function assertPolicyVersion(
  expected: number,
  actual: number,
  policy: string,
): void {
  if (expected !== actual) {
    throw new DomainError(
      "VERSION_CONFLICT",
      `${policy} changed since it was loaded. Refresh and try again.`,
      409,
    );
  }
}

async function unpublishedPageCount(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  spaceId: string,
  userId: string,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM pages
      WHERE organization_id = $1 AND space_id = $2 AND created_by = $3
        AND current_revision_id IS NULL AND state = 'ACTIVE'`,
    [organizationId, spaceId, userId],
  );
  return Number(result.rows[0]!.count);
}

async function otherActiveSpaceAdminCount(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  spaceId: string,
  userId: string,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM space_memberships space_member
       JOIN users u
         ON u.organization_id = space_member.organization_id
        AND u.id = space_member.user_id
      WHERE space_member.organization_id = $1
        AND space_member.space_id = $2
        AND space_member.user_id <> $3
        AND space_member.role = 'ADMIN'
        AND u.state = 'ACTIVE'`,
    [organizationId, spaceId, userId],
  );
  return Number(result.rows[0]!.count);
}

async function spaceMemberById(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  spaceId: string,
  userId: string,
): Promise<SpaceMemberView | null> {
  const result = await client.query<SpaceMemberRow>(
    `SELECT space_member.user_id, u.display_name, u.email, space_member.role,
            (
              SELECT count(*)::integer FROM pages owned_page
               WHERE owned_page.organization_id = space_member.organization_id
                 AND owned_page.space_id = space_member.space_id
                 AND owned_page.created_by = space_member.user_id
                 AND owned_page.current_revision_id IS NULL
                 AND owned_page.state = 'ACTIVE'
            ) AS unpublished_page_count,
            (
              SELECT count(*)::integer FROM page_restriction_members restriction_member
               WHERE restriction_member.organization_id = space_member.organization_id
                 AND restriction_member.space_id = space_member.space_id
                 AND restriction_member.user_id = space_member.user_id
            ) AS page_grant_count
       FROM space_memberships space_member
       JOIN users u
         ON u.organization_id = space_member.organization_id
        AND u.id = space_member.user_id
      WHERE space_member.organization_id = $1
        AND space_member.space_id = $2
        AND space_member.user_id = $3`,
    [organizationId, spaceId, userId],
  );
  return result.rows[0] ? spaceMemberFromRow(result.rows[0]) : null;
}

export async function upsertSpaceMember(
  identity: UserIdentity,
  spaceKey: string,
  userId: string,
  input: { role: SpaceRole; expectedMembershipVersion: number },
  correlationId: string,
): Promise<MembershipMutationResult> {
  return inTransaction(async (client) => {
    const space = await querySpace(identity, spaceKey, client, true);
    if (!space) throw new DomainError("NOT_FOUND", "Space not found", 404);
    assertCapability(identity.organizationRole, space.role, "space:admin");
    assertPolicyVersion(
      input.expectedMembershipVersion,
      space.membership_version,
      "Space membership",
    );
    const organizationMember = await client.query(
      `SELECT 1
         FROM users u
         JOIN memberships organization_member
           ON organization_member.organization_id = u.organization_id
          AND organization_member.user_id = u.id
        WHERE u.organization_id = $1 AND u.id = $2 AND u.state = 'ACTIVE'`,
      [identity.organizationId, userId],
    );
    if (!organizationMember.rowCount) {
      throw new DomainError(
        "INVALID_MEMBER",
        "Only active organization members can join a space",
        422,
      );
    }
    const existing = await client.query<{ role: SpaceRole }>(
      `SELECT role FROM space_memberships
        WHERE organization_id = $1 AND space_id = $2 AND user_id = $3`,
      [identity.organizationId, space.id, userId],
    );
    const priorRole = existing.rows[0]?.role ?? null;
    if (priorRole === input.role) {
      return {
        membershipVersion: space.membership_version,
        member: await spaceMemberById(
          client,
          identity.organizationId,
          space.id,
          userId,
        ),
        affectedPageGrantCount: 0,
      };
    }
    if (
      priorRole === "ADMIN" &&
      input.role !== "ADMIN" &&
      (await otherActiveSpaceAdminCount(
        client,
        identity.organizationId,
        space.id,
        userId,
      )) === 0
    ) {
      throw new DomainError(
        "LAST_SPACE_ADMIN",
        "A space must retain at least one active administrator",
        409,
      );
    }
    if (
      input.role === "VIEWER" &&
      (await unpublishedPageCount(
        client,
        identity.organizationId,
        space.id,
        userId,
      )) > 0
    ) {
      throw new DomainError(
        "UNPUBLISHED_PAGE_OWNER",
        "Publish or trash this member's unpublished pages before removing edit access",
        409,
      );
    }
    await client.query(
      `INSERT INTO space_memberships
        (organization_id, space_id, user_id, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (space_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [identity.organizationId, space.id, userId, input.role],
    );
    const bumped = await client.query<{ membership_version: number }>(
      `UPDATE spaces SET membership_version = membership_version + 1
        WHERE organization_id = $1 AND id = $2
        RETURNING membership_version`,
      [identity.organizationId, space.id],
    );
    await recordEffects(
      client,
      identity,
      priorRole ? "space.member_role_changed" : "space.member_added",
      "space",
      space.id,
      correlationId,
      { userId, priorRole, role: input.role },
    );
    return {
      membershipVersion: bumped.rows[0]!.membership_version,
      member: await spaceMemberById(
        client,
        identity.organizationId,
        space.id,
        userId,
      ),
      affectedPageGrantCount: 0,
    };
  });
}

export async function removeSpaceMember(
  identity: UserIdentity,
  spaceKey: string,
  userId: string,
  expectedMembershipVersion: number,
  correlationId: string,
): Promise<MembershipMutationResult> {
  return inTransaction(async (client) => {
    const space = await querySpace(identity, spaceKey, client, true);
    if (!space) throw new DomainError("NOT_FOUND", "Space not found", 404);
    assertCapability(identity.organizationRole, space.role, "space:admin");
    assertPolicyVersion(
      expectedMembershipVersion,
      space.membership_version,
      "Space membership",
    );
    const existing = await client.query<{
      role: SpaceRole;
      page_grant_count: number;
    }>(
      `SELECT space_member.role,
              (
                SELECT count(*)::integer
                  FROM page_restriction_members restriction_member
                 WHERE restriction_member.organization_id = space_member.organization_id
                   AND restriction_member.space_id = space_member.space_id
                   AND restriction_member.user_id = space_member.user_id
              ) AS page_grant_count
         FROM space_memberships space_member
        WHERE space_member.organization_id = $1
          AND space_member.space_id = $2
          AND space_member.user_id = $3`,
      [identity.organizationId, space.id, userId],
    );
    const row = existing.rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "Member not found", 404);
    if (
      row.role === "ADMIN" &&
      (await otherActiveSpaceAdminCount(
        client,
        identity.organizationId,
        space.id,
        userId,
      )) === 0
    ) {
      throw new DomainError(
        "LAST_SPACE_ADMIN",
        "A space must retain at least one active administrator",
        409,
      );
    }
    const unpublishedCount = await unpublishedPageCount(
      client,
      identity.organizationId,
      space.id,
      userId,
    );
    if (unpublishedCount > 0) {
      throw new DomainError(
        "UNPUBLISHED_PAGE_OWNER",
        "Publish or trash this member's unpublished pages before removal",
        409,
      );
    }
    await client.query(
      `UPDATE page_restrictions restriction
          SET version = restriction.version + 1, updated_at = now()
        WHERE restriction.organization_id = $1
          AND restriction.space_id = $2
          AND EXISTS (
            SELECT 1
              FROM page_restriction_members restriction_member
             WHERE restriction_member.organization_id = restriction.organization_id
               AND restriction_member.space_id = restriction.space_id
               AND restriction_member.page_id = restriction.page_id
               AND restriction_member.user_id = $3
          )`,
      [identity.organizationId, space.id, userId],
    );
    await client.query(
      `DELETE FROM space_memberships
        WHERE organization_id = $1 AND space_id = $2 AND user_id = $3`,
      [identity.organizationId, space.id, userId],
    );
    const bumped = await client.query<{ membership_version: number }>(
      `UPDATE spaces SET membership_version = membership_version + 1
        WHERE organization_id = $1 AND id = $2
        RETURNING membership_version`,
      [identity.organizationId, space.id],
    );
    const affectedPageGrantCount = Number(row.page_grant_count);
    await recordEffects(
      client,
      identity,
      "space.member_removed",
      "space",
      space.id,
      correlationId,
      { userId, role: row.role, affectedPageGrantCount },
    );
    return {
      membershipVersion: bumped.rows[0]!.membership_version,
      member: null,
      affectedPageGrantCount,
    };
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
            slug, state, lifecycle_root_id, version, created_by
       FROM pages
      WHERE organization_id = $1 AND space_id = $2 AND state = 'ACTIVE'
        AND has_effective_page_access($1, $3, id)
      ORDER BY sibling_rank, id
      LIMIT 100`,
    [identity.organizationId, space.id, identity.id],
  );
  return {
    space: spaceFromRow(space, identity),
    pages: result.rows.map(pageFromRow),
  };
}

async function listPageTreeSnapshot(
  client: Pick<PoolClient, "query">,
  identity: UserIdentity,
  spaceKey: string,
  input: { parentId: string | null; cursor: string | null; limit: number },
): Promise<PageTreePage> {
  const space = await querySpace(identity, spaceKey, client);
  if (!space) throw new DomainError("NOT_FOUND", "Space not found", 404);
  assertCapability(identity.organizationRole, space.role, "page:view");

  if (input.parentId) {
    const parentAccess = await pageAccess(identity, input.parentId, client);
    if (!parentAccess || parentAccess.page.space_id !== space.id) {
      throw new DomainError("NOT_FOUND", "Parent page not found", 404);
    }
  }

  const siblingList = await client.query<SiblingListRow>(
    `SELECT parent_id, version
       FROM page_sibling_lists
      WHERE organization_id = $1 AND space_id = $2
        AND parent_id IS NOT DISTINCT FROM $3`,
    [identity.organizationId, space.id, input.parentId],
  );
  const list = siblingList.rows[0];
  if (!list) {
    throw new DomainError(
      "HIERARCHY_STATE_INVALID",
      "The page hierarchy is not initialized",
      409,
    );
  }

  let cursorRank: string | null = null;
  if (input.cursor) {
    const cursor = await client.query<{ sibling_rank: string }>(
      `SELECT sibling_rank
         FROM pages
        WHERE organization_id = $1 AND space_id = $2 AND id = $3
          AND parent_id IS NOT DISTINCT FROM $4 AND state = 'ACTIVE'
          AND has_effective_page_access($1, $5, id)`,
      [
        identity.organizationId,
        space.id,
        input.cursor,
        input.parentId,
        identity.id,
      ],
    );
    if (!cursor.rows[0]) {
      throw new DomainError(
        "PAGE_TREE_CURSOR_INVALID",
        "The page tree changed. Refresh and try again.",
        409,
      );
    }
    cursorRank = cursor.rows[0].sibling_rank;
  }

  // The parent access check above proves every inherited ancestor policy once.
  // Each direct child therefore adds only its own restriction and private-draft
  // ownership rule; evaluating the recursive access function per sibling would
  // turn bounded pagination into an N-by-depth query at scale.
  const result = await client.query<PageTreeRow>(
    `WITH authorized_siblings AS (
       SELECT page.id, page.organization_id, page.space_id, page.parent_id,
              page.current_revision_id, page.title, page.slug,
              page.sibling_rank, page.state, page.lifecycle_root_id,
              page.version, page.created_by
         FROM pages page
        WHERE page.organization_id = $1 AND page.space_id = $2
          AND page.parent_id IS NOT DISTINCT FROM $3
          AND page.state = 'ACTIVE'
          AND (page.current_revision_id IS NOT NULL OR page.created_by = $4)
          AND (
            $8::text = 'ADMIN' OR $9::text = 'ADMIN'
            OR NOT EXISTS (
              SELECT 1
                FROM page_restrictions restriction
               WHERE restriction.organization_id = page.organization_id
                 AND restriction.space_id = page.space_id
                 AND restriction.page_id = page.id
                 AND restriction.enabled
                 AND NOT EXISTS (
                   SELECT 1
                     FROM page_restriction_members allowed_member
                    WHERE allowed_member.organization_id = restriction.organization_id
                      AND allowed_member.space_id = restriction.space_id
                      AND allowed_member.page_id = restriction.page_id
                      AND allowed_member.user_id = $4
                 )
            )
          )
          AND (
            $5::numeric IS NULL
            OR (page.sibling_rank, page.id) > ($5::numeric, $6::uuid)
          )
        ORDER BY page.sibling_rank, page.id
        LIMIT $7
     )
     SELECT page.id, page.organization_id, page.space_id, page.parent_id,
            page.current_revision_id,
            CASE WHEN page.current_revision_id IS NULL
                 THEN COALESCE((SELECT draft.title FROM drafts draft
                                  WHERE draft.page_id = page.id
                                    AND draft.principal_id = $4),
                               'Untitled draft')
                 ELSE page.title END AS title,
            page.slug, page.sibling_rank, page.state, page.lifecycle_root_id,
            page.version, page.created_by,
            EXISTS (
              SELECT 1
                FROM pages child
               WHERE child.organization_id = page.organization_id
                 AND child.space_id = page.space_id
                 AND child.parent_id = page.id
                 AND child.state = 'ACTIVE'
                 AND (
                   child.current_revision_id IS NOT NULL
                   OR child.created_by = $4
                 )
                 AND (
                   $8::text = 'ADMIN' OR $9::text = 'ADMIN'
                   OR NOT EXISTS (
                     SELECT 1
                       FROM page_restrictions restriction
                      WHERE restriction.organization_id = child.organization_id
                        AND restriction.space_id = child.space_id
                        AND restriction.page_id = child.id
                        AND restriction.enabled
                        AND NOT EXISTS (
                          SELECT 1
                            FROM page_restriction_members allowed_member
                           WHERE allowed_member.organization_id = restriction.organization_id
                             AND allowed_member.space_id = restriction.space_id
                             AND allowed_member.page_id = restriction.page_id
                             AND allowed_member.user_id = $4
                        )
                   )
                 )
            ) AS has_children
       FROM authorized_siblings page
      ORDER BY page.sibling_rank, page.id`,
    [
      identity.organizationId,
      space.id,
      input.parentId,
      identity.id,
      cursorRank,
      input.cursor,
      input.limit + 1,
      identity.organizationRole,
      space.role,
    ],
  );
  const hasNext = result.rows.length > input.limit;
  const rows = result.rows.slice(0, input.limit);

  let breadcrumbs: PageBreadcrumb[] = [];
  if (input.parentId) {
    const path = await client.query<PageBreadcrumb & QueryResultRow>(
      `WITH RECURSIVE ancestors AS (
         SELECT page.id, page.parent_id, page.title, page.slug,
                page.current_revision_id, 0 AS depth
           FROM pages page
          WHERE page.organization_id = $1 AND page.space_id = $2
            AND page.id = $3 AND page.state = 'ACTIVE'
            AND has_effective_page_access($1, $4, page.id)

         UNION ALL

         SELECT parent.id, parent.parent_id, parent.title, parent.slug,
                parent.current_revision_id, child.depth + 1
           FROM pages parent
           JOIN ancestors child ON child.parent_id = parent.id
          WHERE parent.organization_id = $1 AND parent.space_id = $2
            AND parent.state = 'ACTIVE'
            AND has_effective_page_access($1, $4, parent.id)
       )
       SELECT ancestor.id,
              CASE WHEN ancestor.current_revision_id IS NULL
                   THEN COALESCE((SELECT draft.title FROM drafts draft
                                    WHERE draft.page_id = ancestor.id
                                      AND draft.principal_id = $4),
                                 'Untitled draft')
                   ELSE ancestor.title END AS title,
              ancestor.slug
         FROM ancestors ancestor
        ORDER BY ancestor.depth DESC`,
      [identity.organizationId, space.id, input.parentId, identity.id],
    );
    breadcrumbs = path.rows.map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
    }));
  }

  return {
    space: spaceFromRow(space, identity),
    parentId: input.parentId,
    parentVersion: list.version,
    breadcrumbs,
    items: rows.map(pageTreeFromRow),
    nextCursor: hasNext ? (rows.at(-1)?.id ?? null) : null,
  };
}

export async function listPageTree(
  identity: UserIdentity,
  spaceKey: string,
  input: { parentId: string | null; cursor: string | null; limit: number },
): Promise<PageTreePage> {
  return inTransaction(async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    return listPageTreeSnapshot(client, identity, spaceKey, input);
  });
}

export async function createPage(
  identity: UserIdentity,
  spaceKey: string,
  input: { title: string; parentId: string | null },
  correlationId: string,
): Promise<PageSummary> {
  return inTransaction(async (client) => {
    const space = await querySpace(identity, spaceKey, client, true);
    if (!space) throw new DomainError("NOT_FOUND", "Space not found", 404);
    assertCapability(identity.organizationRole, space.role, "page:create");
    if (input.parentId) {
      const parent = await client.query(
        `SELECT 1 FROM pages
          WHERE organization_id = $1 AND space_id = $2 AND id = $3
            AND state = 'ACTIVE'
            AND has_effective_page_access($1, $4, id)
          FOR UPDATE`,
        [identity.organizationId, space.id, input.parentId, identity.id],
      );
      if (!parent.rowCount) {
        throw new DomainError("NOT_FOUND", "Parent page not found", 404);
      }
    }
    const siblingList = await client.query<SiblingListRow>(
      `SELECT parent_id, version
         FROM page_sibling_lists
        WHERE organization_id = $1 AND space_id = $2
          AND parent_id IS NOT DISTINCT FROM $3
        FOR UPDATE`,
      [identity.organizationId, space.id, input.parentId],
    );
    if (!siblingList.rowCount) {
      throw new DomainError(
        "HIERARCHY_STATE_INVALID",
        "The page hierarchy is not initialized",
        409,
      );
    }
    await lockSpaceSlugNamespace(client, space.id);
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
                 title, slug, sibling_rank, state, lifecycle_root_id, version,
                 created_by`,
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

function sameParent(left: string | null, right: string | null): boolean {
  return left === right;
}

function siblingListKey(parentId: string | null): string {
  return parentId ?? "__ROOT__";
}

function assertSiblingListVersion(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new DomainError(
      "SIBLING_LIST_VERSION_CONFLICT",
      "The page order changed since it was loaded. Refresh and try again.",
      409,
    );
  }
}

async function siblingPages(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  spaceId: string,
  parentId: string | null,
  movingPageId: string,
): Promise<SiblingPageRow[]> {
  const result = await client.query<SiblingPageRow>(
    `SELECT id, sibling_rank
       FROM pages
      WHERE organization_id = $1 AND space_id = $2
        AND parent_id IS NOT DISTINCT FROM $3
        AND state = 'ACTIVE' AND id <> $4
      ORDER BY sibling_rank, id`,
    [organizationId, spaceId, parentId, movingPageId],
  );
  return result.rows;
}

function neighborRanks(
  siblings: SiblingPageRow[],
  beforePageId: string | null,
  afterPageId: string | null,
): { beforeRank: string | null; afterRank: string | null } {
  const beforeIndex = beforePageId
    ? siblings.findIndex((page) => page.id === beforePageId)
    : -1;
  const afterIndex = afterPageId
    ? siblings.findIndex((page) => page.id === afterPageId)
    : -1;
  const valid =
    beforePageId && afterPageId
      ? beforeIndex >= 0 && afterIndex === beforeIndex + 1
      : beforePageId
        ? beforeIndex === siblings.length - 1
        : afterPageId
          ? afterIndex === 0
          : true;
  if (!valid) {
    throw new DomainError(
      "PAGE_POSITION_INVALID",
      "The requested neighboring pages do not define a current position",
      422,
    );
  }
  return {
    beforeRank:
      beforeIndex >= 0 ? (siblings[beforeIndex]?.sibling_rank ?? null) : null,
    afterRank:
      afterIndex >= 0 ? (siblings[afterIndex]?.sibling_rank ?? null) : null,
  };
}

function numericRankUnits(rank: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(rank);
  if (!match) throw new Error("Invalid persisted sibling rank");
  const scale = 1_000_000_000_000_000n;
  const units =
    BigInt(match[2]!) * scale +
    BigInt((match[3] ?? "").padEnd(15, "0").slice(0, 15) || "0");
  return match[1] ? -units : units;
}

function positionAroundStoredRank(
  siblings: SiblingPageRow[],
  rank: string,
  pageId: string,
): { beforePageId: string | null; afterPageId: string | null } {
  const rankUnits = numericRankUnits(rank);
  const afterIndex = siblings.findIndex((sibling) => {
    const siblingUnits = numericRankUnits(sibling.sibling_rank);
    return (
      siblingUnits > rankUnits ||
      (siblingUnits === rankUnits && sibling.id > pageId)
    );
  });
  if (afterIndex < 0) {
    return {
      beforePageId: siblings.at(-1)?.id ?? null,
      afterPageId: null,
    };
  }
  return {
    beforePageId: siblings[afterIndex - 1]?.id ?? null,
    afterPageId: siblings[afterIndex]!.id,
  };
}

function originalRestoreNeighbors(
  siblings: SiblingPageRow[],
  root: PageRow,
): { beforePageId: string | null; afterPageId: string | null } {
  const beforeIndex = root.lifecycle_before_page_id
    ? siblings.findIndex((page) => page.id === root.lifecycle_before_page_id)
    : -1;
  const afterIndex = root.lifecycle_after_page_id
    ? siblings.findIndex((page) => page.id === root.lifecycle_after_page_id)
    : -1;
  if (beforeIndex >= 0 && afterIndex > beforeIndex) {
    return {
      beforePageId: siblings[beforeIndex]!.id,
      afterPageId: siblings[beforeIndex + 1]?.id ?? null,
    };
  }
  if (beforeIndex >= 0) {
    return {
      beforePageId: siblings[beforeIndex]!.id,
      afterPageId: siblings[beforeIndex + 1]?.id ?? null,
    };
  }
  if (afterIndex >= 0) {
    return {
      beforePageId: siblings[afterIndex - 1]?.id ?? null,
      afterPageId: siblings[afterIndex]!.id,
    };
  }
  return positionAroundStoredRank(siblings, root.sibling_rank, root.id);
}

async function calculateSiblingRank(
  client: Pick<PoolClient, "query">,
  siblings: SiblingPageRow[],
  beforeRank: string | null,
  afterRank: string | null,
): Promise<{ rank: string; exhausted: boolean }> {
  if (beforeRank && afterRank) {
    const result = await client.query<{ rank: string; usable: boolean }>(
      `SELECT (($1::numeric + $2::numeric) / 2)::numeric(30, 15)::text AS rank,
              (($1::numeric + $2::numeric) / 2)::numeric(30, 15) > $1::numeric
              AND (($1::numeric + $2::numeric) / 2)::numeric(30, 15) < $2::numeric
                AS usable`,
      [beforeRank, afterRank],
    );
    return {
      rank: result.rows[0]!.rank,
      exhausted: !result.rows[0]!.usable,
    };
  }
  if (beforeRank) {
    const result = await client.query<{ rank: string }>(
      `SELECT ($1::numeric + 1024)::numeric(30, 15)::text AS rank`,
      [beforeRank],
    );
    return { rank: result.rows[0]!.rank, exhausted: false };
  }
  if (afterRank) {
    const result = await client.query<{ rank: string }>(
      `SELECT ($1::numeric - 1024)::numeric(30, 15)::text AS rank`,
      [afterRank],
    );
    return { rank: result.rows[0]!.rank, exhausted: false };
  }
  const lastRank = siblings.at(-1)?.sibling_rank;
  if (!lastRank) return { rank: "1024", exhausted: false };
  const result = await client.query<{ rank: string }>(
    `SELECT ($1::numeric + 1024)::numeric(30, 15)::text AS rank`,
    [lastRank],
  );
  return { rank: result.rows[0]!.rank, exhausted: false };
}

async function rebalanceSiblingList(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  spaceId: string,
  parentId: string | null,
): Promise<void> {
  await client.query(
    `WITH ordered AS (
       SELECT id,
              row_number() OVER (ORDER BY sibling_rank, id)::numeric * 1024
                AS new_rank
         FROM pages
        WHERE organization_id = $1 AND space_id = $2
          AND parent_id IS NOT DISTINCT FROM $3 AND state = 'ACTIVE'
     )
     UPDATE pages page
        SET sibling_rank = ordered.new_rank
       FROM ordered
      WHERE page.id = ordered.id`,
    [organizationId, spaceId, parentId],
  );
}

async function hierarchyMemberAccess(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  spaceId: string,
  pageId: string,
  destinationParentId: string | null,
): Promise<HierarchyMemberAccessRow[]> {
  const result = await client.query<HierarchyMemberAccessRow>(
    `WITH RECURSIVE old_ancestors AS (
       SELECT page.id, page.parent_id
         FROM pages page
        WHERE page.organization_id = $1 AND page.space_id = $2
          AND page.id = $3

       UNION

       SELECT parent.id, parent.parent_id
         FROM pages parent
         JOIN old_ancestors child ON child.parent_id = parent.id
        WHERE parent.organization_id = $1 AND parent.space_id = $2
     ), destination_ancestors AS (
       SELECT page.id, page.parent_id
         FROM pages page
        WHERE page.organization_id = $1 AND page.space_id = $2
          AND page.id = $4

       UNION

       SELECT parent.id, parent.parent_id
         FROM pages parent
         JOIN destination_ancestors child ON child.parent_id = parent.id
        WHERE parent.organization_id = $1 AND parent.space_id = $2
     ), future_ancestors AS (
       SELECT $3::uuid AS id
       UNION
       SELECT id FROM destination_ancestors
     )
     SELECT member.user_id,
            member.role = 'ADMIN' OR NOT EXISTS (
              SELECT 1
                FROM old_ancestors ancestor
                JOIN page_restrictions restriction
                  ON restriction.organization_id = $1
                 AND restriction.space_id = $2
                 AND restriction.page_id = ancestor.id
                 AND restriction.enabled
               WHERE NOT EXISTS (
                 SELECT 1
                   FROM page_restriction_members allowed
                  WHERE allowed.organization_id = $1
                    AND allowed.space_id = $2
                    AND allowed.page_id = restriction.page_id
                    AND allowed.user_id = member.user_id
               )
            ) AS old_allowed,
            member.role = 'ADMIN' OR NOT EXISTS (
              SELECT 1
                FROM future_ancestors ancestor
                JOIN page_restrictions restriction
                  ON restriction.organization_id = $1
                 AND restriction.space_id = $2
                 AND restriction.page_id = ancestor.id
                 AND restriction.enabled
               WHERE NOT EXISTS (
                 SELECT 1
                   FROM page_restriction_members allowed
                  WHERE allowed.organization_id = $1
                    AND allowed.space_id = $2
                    AND allowed.page_id = restriction.page_id
                    AND allowed.user_id = member.user_id
               )
            ) AS future_allowed
       FROM space_memberships member
       JOIN users active_user
         ON active_user.organization_id = member.organization_id
        AND active_user.id = member.user_id
        AND active_user.state = 'ACTIVE'
      WHERE member.organization_id = $1 AND member.space_id = $2
      ORDER BY member.user_id
      FOR SHARE OF member, active_user`,
    [organizationId, spaceId, pageId, destinationParentId],
  );
  return result.rows;
}

async function materializePageRestriction(
  client: Pick<PoolClient, "query">,
  identity: UserIdentity,
  spaceId: string,
  pageId: string,
  memberIds: string[],
): Promise<void> {
  await client.query(
    `INSERT INTO page_restrictions
      (organization_id, space_id, page_id, version, enabled, created_by)
     VALUES ($1, $2, $3, 1, true, $4)
     ON CONFLICT (page_id) DO UPDATE
       SET version = page_restrictions.version + 1,
           enabled = true,
           updated_at = now()`,
    [identity.organizationId, spaceId, pageId, identity.id],
  );
  await client.query(
    `DELETE FROM page_restriction_members
      WHERE organization_id = $1 AND space_id = $2 AND page_id = $3`,
    [identity.organizationId, spaceId, pageId],
  );
  if (memberIds.length) {
    await client.query(
      `INSERT INTO page_restriction_members
        (organization_id, space_id, page_id, user_id)
       SELECT $1, $2, $3, member_id
         FROM unnest($4::uuid[]) AS member_id`,
      [identity.organizationId, spaceId, pageId, memberIds],
    );
  }
}

export async function movePage(
  identity: UserIdentity,
  pageId: string,
  input: {
    destinationParentId: string | null;
    beforePageId: string | null;
    afterPageId: string | null;
    expectedSourceVersion: number;
    expectedDestinationVersion: number;
  },
  correlationId: string,
): Promise<MovePageResult> {
  return inTransaction(async (client) => {
    let sourceAccess = await pageAccess(identity, pageId, client);
    if (!sourceAccess)
      throw new DomainError("NOT_FOUND", "Page not found", 404);
    const lockedSpace = await querySpace(
      identity,
      sourceAccess.page.space_id,
      client,
      true,
    );
    if (!lockedSpace) {
      throw new DomainError(
        "PAGE_HIERARCHY_CHANGED",
        "The page hierarchy changed. Refresh and try again.",
        409,
      );
    }
    assertCapability(identity.organizationRole, lockedSpace.role, "page:move");

    let destinationAccess = input.destinationParentId
      ? await pageAccess(identity, input.destinationParentId, client)
      : null;
    if (input.destinationParentId && !destinationAccess) {
      throw new DomainError("NOT_FOUND", "Destination page not found", 404);
    }
    if (
      destinationAccess &&
      destinationAccess.page.space_id !== sourceAccess.page.space_id
    ) {
      throw new DomainError(
        "CROSS_SPACE_MOVE",
        "Pages cannot be moved between spaces",
        422,
      );
    }

    const pageLocks = [pageId, input.destinationParentId]
      .filter((value): value is string => value !== null)
      .sort();
    await client.query(
      `SELECT id
         FROM pages
        WHERE organization_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id
        FOR UPDATE`,
      [identity.organizationId, pageLocks],
    );

    sourceAccess = await pageAccess(identity, pageId, client);
    destinationAccess = input.destinationParentId
      ? await pageAccess(identity, input.destinationParentId, client)
      : null;
    if (
      !sourceAccess ||
      (input.destinationParentId && !destinationAccess) ||
      (destinationAccess &&
        destinationAccess.page.space_id !== sourceAccess.page.space_id)
    ) {
      throw new DomainError(
        "PAGE_HIERARCHY_CHANGED",
        "The page hierarchy changed. Refresh and try again.",
        409,
      );
    }
    assertCapability(
      identity.organizationRole,
      sourceAccess.space.role,
      "page:move",
    );

    if (input.destinationParentId) {
      const cycle = await client.query(
        `WITH RECURSIVE subtree AS (
           SELECT id
             FROM pages
            WHERE organization_id = $1 AND space_id = $2 AND id = $3

           UNION

           SELECT child.id
             FROM pages child
             JOIN subtree parent ON child.parent_id = parent.id
            WHERE child.organization_id = $1 AND child.space_id = $2
         )
         SELECT 1 FROM subtree WHERE id = $4 LIMIT 1`,
        [
          identity.organizationId,
          sourceAccess.page.space_id,
          pageId,
          input.destinationParentId,
        ],
      );
      if (cycle.rowCount) {
        throw new DomainError(
          "PAGE_CYCLE",
          "A page cannot be moved beneath its own subtree",
          409,
        );
      }
    }

    const sourceParentId = sourceAccess.page.parent_id;
    const destinationParentId = input.destinationParentId;
    const requestedParents = sameParent(sourceParentId, destinationParentId)
      ? [sourceParentId]
      : [sourceParentId, destinationParentId];
    const siblingLists = await client.query<SiblingListRow>(
      `SELECT parent_id, version
         FROM page_sibling_lists
        WHERE organization_id = $1 AND space_id = $2
          AND (
            parent_id IS NOT DISTINCT FROM $3
            OR parent_id IS NOT DISTINCT FROM $4
          )
        ORDER BY parent_id NULLS FIRST
        FOR UPDATE`,
      [
        identity.organizationId,
        sourceAccess.page.space_id,
        sourceParentId,
        destinationParentId,
      ],
    );
    const versions = new Map(
      siblingLists.rows.map((row) => [
        siblingListKey(row.parent_id),
        row.version,
      ]),
    );
    if (
      requestedParents.some(
        (parentId) => !versions.has(siblingListKey(parentId)),
      )
    ) {
      throw new DomainError(
        "HIERARCHY_STATE_INVALID",
        "The page hierarchy is not initialized",
        409,
      );
    }
    const sourceVersion = versions.get(siblingListKey(sourceParentId))!;
    const destinationVersion = versions.get(
      siblingListKey(destinationParentId),
    )!;
    assertSiblingListVersion(input.expectedSourceVersion, sourceVersion);
    assertSiblingListVersion(
      input.expectedDestinationVersion,
      destinationVersion,
    );

    let accessRows: HierarchyMemberAccessRow[] = [];
    if (!sameParent(sourceParentId, destinationParentId)) {
      accessRows = await hierarchyMemberAccess(
        client,
        identity.organizationId,
        sourceAccess.page.space_id,
        pageId,
        destinationParentId,
      );
    }
    const restrictionMaterialized = accessRows.some(
      (row) => row.future_allowed && !row.old_allowed,
    );
    if (restrictionMaterialized) {
      await materializePageRestriction(
        client,
        identity,
        sourceAccess.page.space_id,
        pageId,
        accessRows.filter((row) => row.old_allowed).map((row) => row.user_id),
      );
    }

    let siblings = await siblingPages(
      client,
      identity.organizationId,
      sourceAccess.page.space_id,
      destinationParentId,
      pageId,
    );
    let ranks = neighborRanks(siblings, input.beforePageId, input.afterPageId);
    let placement = await calculateSiblingRank(
      client,
      siblings,
      ranks.beforeRank,
      ranks.afterRank,
    );
    if (placement.exhausted) {
      await rebalanceSiblingList(
        client,
        identity.organizationId,
        sourceAccess.page.space_id,
        destinationParentId,
      );
      siblings = await siblingPages(
        client,
        identity.organizationId,
        sourceAccess.page.space_id,
        destinationParentId,
        pageId,
      );
      ranks = neighborRanks(siblings, input.beforePageId, input.afterPageId);
      placement = await calculateSiblingRank(
        client,
        siblings,
        ranks.beforeRank,
        ranks.afterRank,
      );
      if (placement.exhausted) {
        throw new DomainError(
          "PAGE_RANK_EXHAUSTED",
          "The page order could not be rebalanced",
          409,
        );
      }
    }

    const moved = await client.query<PageRow>(
      `UPDATE pages
          SET parent_id = $4, sibling_rank = $5, version = version + 1,
              updated_at = now()
        WHERE organization_id = $1 AND space_id = $2 AND id = $3
        RETURNING id, organization_id, space_id, parent_id,
                  current_revision_id, title, slug, sibling_rank, state,
                  lifecycle_root_id, version, created_by`,
      [
        identity.organizationId,
        sourceAccess.page.space_id,
        pageId,
        destinationParentId,
        placement.rank,
      ],
    );
    let movedPage = pageFromRow(moved.rows[0]!);
    if (!moved.rows[0]!.current_revision_id) {
      const draft = await client.query<{ title: string }>(
        `SELECT title
           FROM drafts
          WHERE organization_id = $1 AND page_id = $2 AND principal_id = $3`,
        [identity.organizationId, pageId, identity.id],
      );
      if (draft.rows[0])
        movedPage = { ...movedPage, title: draft.rows[0].title };
    }

    let nextSourceVersion: number;
    let nextDestinationVersion: number;
    if (sameParent(sourceParentId, destinationParentId)) {
      const bumped = await client.query<{ version: number }>(
        `UPDATE page_sibling_lists
            SET version = version + 1, updated_at = now()
          WHERE organization_id = $1 AND space_id = $2
            AND parent_id IS NOT DISTINCT FROM $3
          RETURNING version`,
        [identity.organizationId, sourceAccess.page.space_id, sourceParentId],
      );
      nextSourceVersion = bumped.rows[0]!.version;
      nextDestinationVersion = nextSourceVersion;
    } else {
      const bumped = await client.query<SiblingListRow>(
        `UPDATE page_sibling_lists
            SET version = version + 1, updated_at = now()
          WHERE organization_id = $1 AND space_id = $2
            AND (
              parent_id IS NOT DISTINCT FROM $3
              OR parent_id IS NOT DISTINCT FROM $4
            )
          RETURNING parent_id, version`,
        [
          identity.organizationId,
          sourceAccess.page.space_id,
          sourceParentId,
          destinationParentId,
        ],
      );
      const nextVersions = new Map(
        bumped.rows.map((row) => [siblingListKey(row.parent_id), row.version]),
      );
      nextSourceVersion = nextVersions.get(siblingListKey(sourceParentId))!;
      nextDestinationVersion = nextVersions.get(
        siblingListKey(destinationParentId),
      )!;
    }

    await recordEffects(
      client,
      identity,
      "page.moved",
      "page",
      pageId,
      correlationId,
      {
        sourceParentId,
        destinationParentId,
        sourceVersion: nextSourceVersion,
        destinationVersion: nextDestinationVersion,
        restrictionMaterialized,
      },
    );
    return {
      page: movedPage,
      sourceParentId,
      destinationParentId,
      sourceVersion: nextSourceVersion,
      destinationVersion: nextDestinationVersion,
      restrictionMaterialized,
    };
  });
}

async function lifecyclePageAccess(
  identity: UserIdentity,
  pageId: string,
  client: Pick<PoolClient, "query">,
): Promise<{ page: PageRow; space: SpaceRow } | null> {
  const result = await client.query<PageRow & SpaceRow>(
    `SELECT p.id, p.organization_id, p.space_id, p.parent_id,
            p.current_revision_id, p.title, p.slug, p.sibling_rank, p.state,
            p.lifecycle_root_id, p.lifecycle_before_page_id,
            p.lifecycle_after_page_id, p.version, p.created_by,
            s.space_key, s.name, s.description, s.version AS space_version,
            s.membership_version AS space_membership_version,
            membership.role
       FROM pages p
       JOIN spaces s
         ON s.organization_id = p.organization_id AND s.id = p.space_id
       LEFT JOIN space_memberships membership
         ON membership.organization_id = p.organization_id
        AND membership.space_id = p.space_id
        AND membership.user_id = $2
      WHERE p.organization_id = $1 AND p.id = $3
        AND s.archived_at IS NULL
        AND ($4 = 'ADMIN' OR membership.user_id IS NOT NULL)
        AND (
          (
            p.state IN ('ACTIVE', 'ARCHIVED')
            AND has_effective_page_access($1, $2, p.id)
          )
          OR (
            p.state = 'TRASHED'
            AND (
              $4 = 'ADMIN'
              OR membership.role = 'ADMIN'
              OR (
                p.current_revision_id IS NULL
                AND p.created_by = $2
                AND has_effective_page_policy_access($1, $2, p.id)
              )
            )
          )
        )`,
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
      membership_version: Number(
        (row as unknown as { space_membership_version: number })
          .space_membership_version,
      ),
    },
  };
}

async function lockLifecycleSubtree(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  spaceId: string,
  rootPageId: string,
): Promise<LifecycleSubtreeRow[]> {
  const result = await client.query<LifecycleSubtreeRow>(
    `WITH RECURSIVE subtree AS (
       SELECT root.id, root.state, root.lifecycle_root_id
         FROM pages root
        WHERE root.organization_id = $1 AND root.space_id = $2
          AND root.id = $3

       UNION ALL

       SELECT child.id, child.state, child.lifecycle_root_id
         FROM pages child
         JOIN subtree parent
           ON child.parent_id = parent.id
          AND child.state = parent.state
          AND child.lifecycle_root_id IS NOT DISTINCT FROM parent.lifecycle_root_id
        WHERE child.organization_id = $1 AND child.space_id = $2
     )
     SELECT page.id, page.organization_id, page.space_id, page.parent_id,
            page.current_revision_id, page.title, page.slug,
            page.sibling_rank, page.state, page.lifecycle_root_id,
            page.lifecycle_before_page_id, page.lifecycle_after_page_id,
            page.version, page.created_by,
            page.current_revision_id IS NOT NULL AS published
       FROM pages page
       JOIN subtree ON subtree.id = page.id
      ORDER BY page.id
      FOR UPDATE OF page`,
    [organizationId, spaceId, rootPageId],
  );
  return result.rows;
}

function isLifecycleAdministrator(
  identity: UserIdentity,
  space: SpaceRow,
): boolean {
  return identity.organizationRole === "ADMIN" || space.role === "ADMIN";
}

async function activeLifecycleDestination(
  client: Pick<PoolClient, "query">,
  identity: UserIdentity,
  spaceId: string,
  destinationParentId: string | null,
): Promise<boolean> {
  if (destinationParentId === null) return true;
  const result = await client.query(
    `SELECT 1
       FROM pages
      WHERE organization_id = $1 AND space_id = $2 AND id = $3
        AND state = 'ACTIVE'
        AND has_effective_page_policy_access($1, $4, id)`,
    [identity.organizationId, spaceId, destinationParentId, identity.id],
  );
  return Boolean(result.rowCount);
}

export async function changePageLifecycle(
  identity: UserIdentity,
  pageId: string,
  input: {
    action: "ARCHIVE" | "TRASH" | "RESTORE";
    expectedVersion: number;
    expectedParentVersion: number;
    destinationParentId?: string | null | undefined;
    beforePageId?: string | null | undefined;
    afterPageId?: string | null | undefined;
  },
  correlationId: string,
): Promise<PageLifecycleResult> {
  return inTransaction(async (client) => {
    let access = await lifecyclePageAccess(identity, pageId, client);
    if (!access) throw new DomainError("NOT_FOUND", "Page not found", 404);
    const lockedSpace = await querySpace(
      identity,
      access.page.space_id,
      client,
      true,
    );
    if (!lockedSpace) {
      throw new DomainError(
        "PAGE_LIFECYCLE_CHANGED",
        "The page lifecycle changed. Refresh and try again.",
        409,
      );
    }
    access = await lifecyclePageAccess(identity, pageId, client);
    if (!access) {
      throw new DomainError(
        "PAGE_LIFECYCLE_CHANGED",
        "The page lifecycle changed. Refresh and try again.",
        409,
      );
    }

    if (input.action === "ARCHIVE") {
      assertCapability(
        identity.organizationRole,
        access.space.role,
        "page:archive",
      );
    } else if (input.action === "TRASH") {
      assertCapability(
        identity.organizationRole,
        access.space.role,
        "page:trash",
      );
    } else {
      assertCapability(
        identity.organizationRole,
        access.space.role,
        "page:restore",
      );
    }

    const subtree = await lockLifecycleSubtree(
      client,
      identity.organizationId,
      access.page.space_id,
      pageId,
    );
    const root = subtree.find((page) => page.id === pageId);
    if (!root) {
      throw new DomainError(
        "PAGE_LIFECYCLE_CHANGED",
        "The page lifecycle changed. Refresh and try again.",
        409,
      );
    }
    if (root.version !== input.expectedVersion) {
      throw new DomainError(
        "PAGE_VERSION_CONFLICT",
        "The page changed since it was loaded. Refresh and try again.",
        409,
      );
    }

    const administrator = isLifecycleAdministrator(identity, access.space);
    const unpublished = subtree.filter((page) => !page.published);
    const foreignUnpublished = unpublished.filter(
      (page) => page.created_by !== identity.id,
    );
    if (foreignUnpublished.length) {
      throw new DomainError(
        "SUBTREE_PRIVATE_DRAFTS",
        `The subtree contains ${foreignUnpublished.length} unpublished page${
          foreignUnpublished.length === 1 ? "" : "s"
        } owned by another principal`,
        409,
      );
    }

    if (input.action === "ARCHIVE") {
      if (root.state !== "ACTIVE") {
        throw new DomainError(
          "PAGE_STATE_CONFLICT",
          "Only an active subtree can be archived",
          409,
        );
      }
      if (unpublished.length) {
        throw new DomainError(
          "SUBTREE_UNPUBLISHED",
          `Archive requires every page to be published; ${unpublished.length} unpublished page${
            unpublished.length === 1 ? "" : "s"
          } remain`,
          422,
        );
      }
    } else if (input.action === "TRASH") {
      if (root.state === "TRASHED") {
        throw new DomainError(
          "PAGE_STATE_CONFLICT",
          "The subtree is already trashed",
          409,
        );
      }
      if (!administrator && subtree.some((page) => page.published)) {
        throw new DomainError(
          "FORBIDDEN",
          "Only an administrator may trash a published subtree",
          403,
        );
      }
      if (
        !administrator &&
        subtree.some((page) => page.created_by !== identity.id)
      ) {
        throw new DomainError(
          "FORBIDDEN",
          "An editor may trash only their own unpublished subtree",
          403,
        );
      }
    } else {
      if (root.state === "ACTIVE") {
        throw new DomainError(
          "PAGE_STATE_CONFLICT",
          "Only an archived or trashed subtree can be restored",
          409,
        );
      }
      if (!administrator && subtree.some((page) => page.published)) {
        throw new DomainError(
          "FORBIDDEN",
          "Only an administrator may restore a published subtree",
          403,
        );
      }
      if (
        !administrator &&
        subtree.some((page) => page.created_by !== identity.id)
      ) {
        throw new DomainError(
          "FORBIDDEN",
          "An editor may restore only their own unpublished subtree",
          403,
        );
      }
    }

    let destinationParentId = root.parent_id;
    let destinationRank = root.sibling_rank;
    let restoredToFallback = false;
    if (input.action === "RESTORE") {
      const originalParentActive = await activeLifecycleDestination(
        client,
        identity,
        root.space_id,
        root.parent_id,
      );
      if (originalParentActive) {
        if (
          (input.destinationParentId !== undefined &&
            input.destinationParentId !== root.parent_id) ||
          input.beforePageId !== undefined ||
          input.afterPageId !== undefined
        ) {
          throw new DomainError(
            "RESTORE_DESTINATION_INVALID",
            "The original parent is active and remains the restore destination",
            422,
          );
        }
      } else {
        if (input.destinationParentId === undefined) {
          throw new DomainError(
            "RESTORE_DESTINATION_REQUIRED",
            "Choose an active destination because the original parent is unavailable",
            422,
          );
        }
        if (!administrator) {
          throw new DomainError(
            "FORBIDDEN",
            "Only an administrator may choose a fallback restore destination",
            403,
          );
        }
        if (
          !(await activeLifecycleDestination(
            client,
            identity,
            root.space_id,
            input.destinationParentId,
          ))
        ) {
          throw new DomainError(
            "NOT_FOUND",
            "Restore destination not found",
            404,
          );
        }
        destinationParentId = input.destinationParentId;
        restoredToFallback = true;
      }
    }

    const siblingList = await client.query<SiblingListRow>(
      `SELECT parent_id, version
         FROM page_sibling_lists
        WHERE organization_id = $1 AND space_id = $2
          AND parent_id IS NOT DISTINCT FROM $3
        FOR UPDATE`,
      [identity.organizationId, root.space_id, destinationParentId],
    );
    const parentList = siblingList.rows[0];
    if (!parentList) {
      throw new DomainError(
        "HIERARCHY_STATE_INVALID",
        "The page hierarchy is not initialized",
        409,
      );
    }
    assertSiblingListVersion(input.expectedParentVersion, parentList.version);

    let restrictionMaterialized = false;
    const leavingActive = root.state === "ACTIVE" && input.action !== "RESTORE";
    let lifecycleBeforePageId = root.lifecycle_before_page_id;
    let lifecycleAfterPageId = root.lifecycle_after_page_id;
    if (leavingActive) {
      const siblings = await siblingPages(
        client,
        identity.organizationId,
        root.space_id,
        root.parent_id,
        pageId,
      );
      const origin = positionAroundStoredRank(
        siblings,
        root.sibling_rank,
        root.id,
      );
      lifecycleBeforePageId = origin.beforePageId;
      lifecycleAfterPageId = origin.afterPageId;
    }
    if (leavingActive && subtree.some((page) => page.published)) {
      const accessRows = await hierarchyMemberAccess(
        client,
        identity.organizationId,
        root.space_id,
        pageId,
        null,
      );
      restrictionMaterialized = accessRows.some(
        (row) => row.future_allowed && !row.old_allowed,
      );
      if (restrictionMaterialized) {
        await materializePageRestriction(
          client,
          identity,
          root.space_id,
          pageId,
          accessRows.filter((row) => row.old_allowed).map((row) => row.user_id),
        );
      }
    }

    if (input.action === "RESTORE") {
      if (restoredToFallback) {
        const accessRows = await hierarchyMemberAccess(
          client,
          identity.organizationId,
          root.space_id,
          pageId,
          destinationParentId,
        );
        restrictionMaterialized = accessRows.some(
          (row) => row.future_allowed && !row.old_allowed,
        );
        if (restrictionMaterialized) {
          await materializePageRestriction(
            client,
            identity,
            root.space_id,
            pageId,
            accessRows
              .filter((row) => row.old_allowed)
              .map((row) => row.user_id),
          );
        }
      }
      let siblings = await siblingPages(
        client,
        identity.organizationId,
        root.space_id,
        destinationParentId,
        pageId,
      );
      let requestedNeighbors = restoredToFallback
        ? {
            beforePageId: input.beforePageId ?? null,
            afterPageId: input.afterPageId ?? null,
          }
        : originalRestoreNeighbors(siblings, root);
      let ranks = neighborRanks(
        siblings,
        requestedNeighbors.beforePageId,
        requestedNeighbors.afterPageId,
      );
      let placement = await calculateSiblingRank(
        client,
        siblings,
        ranks.beforeRank,
        ranks.afterRank,
      );
      if (placement.exhausted) {
        await rebalanceSiblingList(
          client,
          identity.organizationId,
          root.space_id,
          destinationParentId,
        );
        siblings = await siblingPages(
          client,
          identity.organizationId,
          root.space_id,
          destinationParentId,
          pageId,
        );
        requestedNeighbors = restoredToFallback
          ? requestedNeighbors
          : originalRestoreNeighbors(siblings, root);
        ranks = neighborRanks(
          siblings,
          requestedNeighbors.beforePageId,
          requestedNeighbors.afterPageId,
        );
        placement = await calculateSiblingRank(
          client,
          siblings,
          ranks.beforeRank,
          ranks.afterRank,
        );
      }
      if (placement.exhausted) {
        throw new DomainError(
          "PAGE_RANK_EXHAUSTED",
          "The page order could not be rebalanced",
          409,
        );
      }
      destinationRank = placement.rank;
    }

    const targetState =
      input.action === "ARCHIVE"
        ? "ARCHIVED"
        : input.action === "TRASH"
          ? "TRASHED"
          : "ACTIVE";
    const updated = await client.query<PageRow>(
      `UPDATE pages
          SET state = $4,
              lifecycle_root_id = CASE
                WHEN $4 = 'ACTIVE' THEN NULL::uuid
                ELSE $3::uuid
              END,
              lifecycle_before_page_id = CASE
                WHEN $4 = 'ACTIVE' THEN NULL::uuid
                WHEN id = $3 AND $10::boolean THEN $8::uuid
                ELSE lifecycle_before_page_id
              END,
              lifecycle_after_page_id = CASE
                WHEN $4 = 'ACTIVE' THEN NULL::uuid
                WHEN id = $3 AND $10::boolean THEN $9::uuid
                ELSE lifecycle_after_page_id
              END,
              parent_id = CASE WHEN id = $3 THEN $5 ELSE parent_id END,
              sibling_rank = CASE WHEN id = $3 THEN $6 ELSE sibling_rank END,
              version = version + 1,
              updated_at = now()
        WHERE organization_id = $1 AND space_id = $2
          AND id = ANY($7::uuid[])
        RETURNING id, organization_id, space_id, parent_id,
                  current_revision_id, title, slug, sibling_rank, state,
                  lifecycle_root_id, lifecycle_before_page_id,
                  lifecycle_after_page_id, version, created_by`,
      [
        identity.organizationId,
        root.space_id,
        pageId,
        targetState,
        destinationParentId,
        destinationRank,
        subtree.map((page) => page.id),
        lifecycleBeforePageId,
        lifecycleAfterPageId,
        leavingActive,
      ],
    );
    const updatedRoot = updated.rows.find((page) => page.id === pageId);
    if (!updatedRoot) throw new Error("Lifecycle root update failed");

    const changesActiveProjection =
      (root.state === "ACTIVE" && targetState !== "ACTIVE") ||
      (root.state !== "ACTIVE" && targetState === "ACTIVE");
    let parentVersion = parentList.version;
    if (changesActiveProjection) {
      const bumped = await client.query<{ version: number }>(
        `UPDATE page_sibling_lists
            SET version = version + 1, updated_at = now()
          WHERE organization_id = $1 AND space_id = $2
            AND parent_id IS NOT DISTINCT FROM $3
          RETURNING version`,
        [identity.organizationId, root.space_id, destinationParentId],
      );
      parentVersion = bumped.rows[0]!.version;
    }

    const action =
      input.action === "ARCHIVE"
        ? "page.archived"
        : input.action === "TRASH"
          ? "page.trashed"
          : "page.restored";
    await recordEffects(
      client,
      identity,
      action,
      "page",
      pageId,
      correlationId,
      {
        affectedPageCount: subtree.length,
        sourceParentId: root.parent_id,
        destinationParentId,
        restoredToFallback,
        restrictionMaterialized,
      },
    );
    return {
      page: pageFromRow(updatedRoot),
      action: input.action,
      affectedPageCount: subtree.length,
      parentVersion,
      restrictionMaterialized,
      restoredToFallback,
    };
  });
}

async function uniqueSlug(
  client: Pick<PoolClient, "query">,
  spaceId: string,
  title: string,
  pageId: string | null = null,
): Promise<string> {
  const base = slugify(title);
  const result = await client.query<{ slug: string; page_id: string }>(
    `SELECT slug, page_id
       FROM page_aliases
      WHERE space_id = $1 AND (slug = $2 OR slug LIKE $3)
      ORDER BY slug`,
    [spaceId, base, `${base}-%`],
  );
  const owners = new Map(result.rows.map((row) => [row.slug, row.page_id]));
  if (!owners.has(base) || owners.get(base) === pageId) return base;
  let suffix = 2;
  while (
    owners.has(`${base}-${suffix}`) &&
    owners.get(`${base}-${suffix}`) !== pageId
  ) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

async function lockSpaceSlugNamespace(
  client: Pick<PoolClient, "query">,
  spaceId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    [`page-slug:${spaceId}`],
  );
}

async function assignPublishedTitle(
  client: Pick<PoolClient, "query">,
  page: PageRow,
  title: string,
): Promise<{ slug: string; renamed: boolean }> {
  await lockSpaceSlugNamespace(client, page.space_id);
  const slug = await uniqueSlug(client, page.space_id, title, page.id);
  await client.query(
    `INSERT INTO page_aliases (organization_id, space_id, page_id, slug)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (space_id, slug) DO NOTHING`,
    [page.organization_id, page.space_id, page.id, slug],
  );
  return { slug, renamed: page.title !== title || page.slug !== slug };
}

export async function resolvePageAlias(
  identity: UserIdentity,
  spaceKey: string,
  slug: string,
): Promise<PageAliasResolution> {
  const space = await querySpace(identity, spaceKey);
  if (!space) throw new DomainError("NOT_FOUND", "Page not found", 404);
  assertCapability(identity.organizationRole, space.role, "page:view");
  const result = await getPool().query<{
    id: string;
    slug: string;
    state: "ACTIVE" | "ARCHIVED";
  }>(
    `SELECT page.id, page.slug, page.state
       FROM page_aliases alias
       JOIN pages page
         ON page.organization_id = alias.organization_id
        AND page.space_id = alias.space_id
        AND page.id = alias.page_id
      WHERE alias.organization_id = $1 AND alias.space_id = $2
        AND alias.slug = $3
        AND page.state IN ('ACTIVE', 'ARCHIVED')
        AND has_effective_page_access($1, $4, page.id)`,
    [identity.organizationId, space.id, slug, identity.id],
  );
  const page = result.rows[0];
  if (!page) throw new DomainError("NOT_FOUND", "Page not found", 404);
  return {
    pageId: page.id,
    canonicalSlug: page.slug,
    state: page.state,
    canonicalPath: `/pages/${page.id}`,
  };
}

async function pageAccess(
  identity: UserIdentity,
  pageId: string,
  client: Pick<PoolClient, "query"> = getPool(),
  lock = false,
): Promise<{ page: PageRow; space: SpaceRow } | null> {
  const result = await client.query<PageRow & SpaceRow>(
    `SELECT p.id, p.organization_id, p.space_id, p.parent_id,
            p.current_revision_id, p.title, p.slug, p.sibling_rank, p.state,
            p.version, p.created_by,
            s.space_key, s.name, s.description, s.version AS space_version,
            s.membership_version AS space_membership_version,
            g.role
       FROM pages p
       JOIN spaces s ON s.organization_id = p.organization_id AND s.id = p.space_id
       LEFT JOIN space_memberships g ON g.organization_id = p.organization_id
                               AND g.space_id = p.space_id AND g.user_id = $2
      WHERE p.organization_id = $1 AND p.id = $3 AND p.state = 'ACTIVE'
        AND s.archived_at IS NULL
        AND ($4 = 'ADMIN' OR g.user_id IS NOT NULL)
        AND has_effective_page_access($1, $2, p.id)
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
      membership_version: Number(
        (row as unknown as { space_membership_version: number })
          .space_membership_version,
      ),
    },
  };
}

export async function getPublishedPage(
  identity: UserIdentity,
  pageId: string,
): Promise<PublishedPageView> {
  const result = await getPool().query<PageRow & SpaceRow>(
    `SELECT page.id, page.organization_id, page.space_id, page.parent_id,
            page.current_revision_id, page.title, page.slug,
            page.sibling_rank, page.state, page.version, page.created_by,
            space.space_key, space.name, space.description,
            space.version AS space_version,
            space.membership_version AS space_membership_version,
            membership.role
       FROM pages page
       JOIN spaces space
         ON space.organization_id = page.organization_id
        AND space.id = page.space_id
       LEFT JOIN space_memberships membership
         ON membership.organization_id = page.organization_id
        AND membership.space_id = page.space_id
        AND membership.user_id = $2
      WHERE page.organization_id = $1 AND page.id = $3
        AND page.state IN ('ACTIVE', 'ARCHIVED')
        AND page.current_revision_id IS NOT NULL
        AND space.archived_at IS NULL
        AND ($4 = 'ADMIN' OR membership.user_id IS NOT NULL)
        AND has_effective_page_access($1, $2, page.id)`,
    [identity.organizationId, identity.id, pageId, identity.organizationRole],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError("NOT_FOUND", "Page not found", 404);
  const revision = await getPool().query<RevisionRow>(
    `SELECT revision.id, revision.number, revision.title,
            revision.body_json, revision.body_text, revision.summary,
            author.display_name AS author_name, revision.created_at
       FROM page_revisions revision
       JOIN users author
         ON author.organization_id = revision.organization_id
        AND author.id = revision.author_id
      WHERE revision.organization_id = $1 AND revision.page_id = $2
        AND revision.id = $3`,
    [identity.organizationId, pageId, row.current_revision_id],
  );
  const current = revision.rows[0];
  if (!current) {
    throw new DomainError(
      "PUBLICATION_STATE_INVALID",
      "The published page is unavailable",
      409,
    );
  }
  const space: SpaceRow = {
    ...row,
    id: row.space_id,
    version: Number(
      (row as unknown as { space_version: number }).space_version,
    ),
    membership_version: Number(
      (row as unknown as { space_membership_version: number })
        .space_membership_version,
    ),
  };
  return {
    page: pageFromRow(row),
    space: spaceFromRow(space, identity),
    revision: revisionFromRow(current),
    canEdit:
      row.state === "ACTIVE" &&
      can(identity.organizationRole, space.role, "page:edit"),
    readOnly: true,
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
    const access = await pageAccess(identity, pageId, client, true);
    if (!access) throw new DomainError("NOT_FOUND", "Page not found", 404);
    assertCapability(
      identity.organizationRole,
      access.space.role,
      "page:publish",
    );
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
    const unpublishedAncestor = await client.query(
      `WITH RECURSIVE ancestors AS (
         SELECT parent.id, parent.parent_id, parent.current_revision_id
           FROM pages page
           JOIN pages parent
             ON parent.organization_id = page.organization_id
            AND parent.space_id = page.space_id
            AND parent.id = page.parent_id
          WHERE page.organization_id = $1 AND page.id = $2

         UNION ALL

         SELECT parent.id, parent.parent_id, parent.current_revision_id
           FROM pages parent
           JOIN ancestors child ON child.parent_id = parent.id
          WHERE parent.organization_id = $1
       )
       SELECT 1
         FROM ancestors
        WHERE current_revision_id IS NULL
        LIMIT 1`,
      [identity.organizationId, pageId],
    );
    if (unpublishedAncestor.rowCount) {
      throw new DomainError(
        "PAGE_ANCESTOR_UNPUBLISHED",
        "Publish every ancestor before publishing this page",
        409,
      );
    }
    const publishedTitle = await assignPublishedTitle(
      client,
      access.page,
      input.title,
    );
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
          SET current_revision_id = $3, title = $4, slug = $5,
              version = version + 1,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [
        identity.organizationId,
        pageId,
        revisionId,
        input.title,
        publishedTitle.slug,
      ],
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
    if (access.page.current_revision_id && publishedTitle.renamed) {
      await recordEffects(
        client,
        identity,
        "page.renamed",
        "page",
        pageId,
        correlationId,
        { revisionId },
      );
    }
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
    const access = await pageAccess(identity, pageId, client, true);
    if (!access) throw new DomainError("NOT_FOUND", "Page not found", 404);
    assertCapability(
      identity.organizationRole,
      access.space.role,
      "page:restore",
    );
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
    const publishedTitle = await assignPublishedTitle(
      client,
      access.page,
      source.title,
    );
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
          SET current_revision_id = $3, title = $4, slug = $5,
              version = version + 1,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [
        identity.organizationId,
        pageId,
        revisionId,
        source.title,
        publishedTitle.slug,
      ],
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
    if (publishedTitle.renamed) {
      await recordEffects(
        client,
        identity,
        "page.renamed",
        "page",
        pageId,
        correlationId,
        { revisionId },
      );
    }
    return revisionFromRow(inserted.rows[0]!);
  });
}

async function pageRestrictionAdministration(
  client: Pick<PoolClient, "query">,
  identity: UserIdentity,
  access: { page: PageRow; space: SpaceRow },
): Promise<PageRestrictionAdministration> {
  const restriction = await client.query<PageRestrictionRow>(
    `SELECT version, enabled
       FROM page_restrictions
      WHERE organization_id = $1 AND space_id = $2 AND page_id = $3`,
    [identity.organizationId, access.space.id, access.page.id],
  );
  const memberIds = await client.query<{ user_id: string }>(
    `SELECT user_id
       FROM page_restriction_members
      WHERE organization_id = $1 AND space_id = $2 AND page_id = $3
      ORDER BY user_id`,
    [identity.organizationId, access.space.id, access.page.id],
  );
  let page = pageFromRow(access.page);
  if (!access.page.current_revision_id) {
    const draft = await client.query<{ title: string }>(
      `SELECT title FROM drafts
        WHERE organization_id = $1 AND page_id = $2 AND principal_id = $3`,
      [identity.organizationId, access.page.id, identity.id],
    );
    if (draft.rows[0]) page = { ...page, title: draft.rows[0].title };
  }
  return {
    page,
    space: spaceFromRow(access.space, identity),
    restricted: restriction.rows[0]?.enabled ?? false,
    version: restriction.rows[0]?.version ?? 0,
    memberIds: memberIds.rows.map((row) => row.user_id),
  };
}

export async function getPageRestrictionAdministration(
  identity: UserIdentity,
  pageId: string,
): Promise<PageRestrictionAdministration> {
  const access = await pageAccess(identity, pageId);
  if (!access) throw new DomainError("NOT_FOUND", "Page not found", 404);
  assertCapability(identity.organizationRole, access.space.role, "space:admin");
  return pageRestrictionAdministration(getPool(), identity, access);
}

export async function updatePageRestriction(
  identity: UserIdentity,
  pageId: string,
  input: {
    restricted: boolean;
    memberIds: string[];
    expectedVersion: number;
  },
  correlationId: string,
): Promise<PageRestrictionAdministration> {
  return inTransaction(async (client) => {
    const initialAccess = await pageAccess(identity, pageId, client);
    if (!initialAccess)
      throw new DomainError("NOT_FOUND", "Page not found", 404);
    const lockedSpace = await querySpace(
      identity,
      initialAccess.page.space_id,
      client,
      true,
    );
    if (!lockedSpace) throw new DomainError("NOT_FOUND", "Page not found", 404);
    assertCapability(
      identity.organizationRole,
      lockedSpace.role,
      "space:admin",
    );
    const access = await pageAccess(identity, pageId, client, true);
    if (!access) throw new DomainError("NOT_FOUND", "Page not found", 404);
    const restriction = await client.query<PageRestrictionRow>(
      `SELECT version, enabled
         FROM page_restrictions
        WHERE organization_id = $1 AND space_id = $2 AND page_id = $3
        FOR UPDATE`,
      [identity.organizationId, access.space.id, pageId],
    );
    const actualVersion = restriction.rows[0]?.version ?? 0;
    assertPolicyVersion(
      input.expectedVersion,
      actualVersion,
      "Page restriction",
    );
    if (input.restricted && input.memberIds.length) {
      const eligible = await client.query<{ user_id: string }>(
        `SELECT space_member.user_id
           FROM space_memberships space_member
           JOIN users u
             ON u.organization_id = space_member.organization_id
            AND u.id = space_member.user_id
          WHERE space_member.organization_id = $1
            AND space_member.space_id = $2
            AND space_member.user_id = ANY($3::uuid[])
            AND u.state = 'ACTIVE'
          FOR SHARE OF space_member`,
        [identity.organizationId, access.space.id, input.memberIds],
      );
      if (eligible.rows.length !== input.memberIds.length) {
        throw new DomainError(
          "INVALID_RESTRICTION_MEMBER",
          "Every allowed user must be an active member of this space",
          409,
        );
      }
    }
    if (!restriction.rows[0] && !input.restricted) {
      return pageRestrictionAdministration(client, identity, access);
    }
    if (restriction.rows[0]) {
      await client.query(
        `UPDATE page_restrictions
            SET enabled = $4, version = version + 1, updated_at = now()
          WHERE organization_id = $1 AND space_id = $2 AND page_id = $3`,
        [identity.organizationId, access.space.id, pageId, input.restricted],
      );
    } else {
      await client.query(
        `INSERT INTO page_restrictions
          (organization_id, space_id, page_id, enabled, created_by)
         VALUES ($1, $2, $3, true, $4)`,
        [identity.organizationId, access.space.id, pageId, identity.id],
      );
    }
    await client.query(
      `DELETE FROM page_restriction_members
        WHERE organization_id = $1 AND space_id = $2 AND page_id = $3`,
      [identity.organizationId, access.space.id, pageId],
    );
    if (input.restricted && input.memberIds.length) {
      await client.query(
        `INSERT INTO page_restriction_members
          (organization_id, space_id, page_id, user_id)
         SELECT $1, $2, $3, member_id
           FROM unnest($4::uuid[]) AS member_id`,
        [identity.organizationId, access.space.id, pageId, input.memberIds],
      );
    }
    await recordEffects(
      client,
      identity,
      "page.restriction_updated",
      "page",
      pageId,
      correlationId,
      {
        restricted: input.restricted,
        memberCount: input.restricted ? input.memberIds.length : 0,
      },
    );
    return pageRestrictionAdministration(client, identity, access);
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
