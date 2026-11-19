import { createHash, randomBytes, randomUUID } from "node:crypto";
import { issueSearchQuerySchema } from "@vibe/contracts";
import type {
  AssignableUserView,
  AdministrationSettingsView,
  AdministrationProjectView,
  AdministrationUserView,
  AdministrationTeamsView,
  AttachmentScanState,
  AttachmentView,
  AuditEventsQuery,
  AuditEventsView,
  BoardColumnView,
  BoardIssuePage,
  BoardIssuesQuery,
  BoardSettingsView,
  BoardView,
  CommentView,
  CreateSavedFilterInput,
  CsvImportPolicy,
  CsvValidationReport,
  DataJobsView,
  DataJobView,
  DeletedIssuesView,
  DeletedIssueView,
  IssueDetailView,
  IssueCollaborationView,
  IssueEventView,
  IssueSearchFacets,
  IssueSearchItem,
  IssueSearchPage,
  IssueSearchQuery,
  IssueType,
  InviteOrganizationUserInput,
  IssueView,
  KanbanReportsView,
  NotificationCenterView,
  NotificationEventClass,
  NotificationPreferences,
  NotificationView,
  OutboxHealthView,
  Page,
  Priority,
  ProjectMemberView,
  ProjectMembersView,
  ProjectSummary,
  ProjectTemplate,
  ProjectTeamsView,
  ReportsQuery,
  QuickFilterView,
  SavedFilterQuery,
  SavedFilterView,
  SavedFilterVisibility,
  StatusCategory,
  StatusView,
  TransitionView,
  UpdateSavedFilterInput,
  UpdateAdminProjectInput,
  UpdateOrganizationSettingsInput,
  UpdateOrganizationUserInput,
  UpdateWorkflowConfigurationInput,
  UserIdentity,
  WorkflowSettingsView,
} from "@vibe/contracts";
import {
  can,
  assertCapability,
  assertChildrenCompatible,
  assertIssueParent,
  assertTransition,
  assertVersion,
  DomainError,
  hashPassword,
  categoryAt,
  computeIssueFlowMetrics,
  parseMentionEmails,
  type IssueHierarchyLevel,
  type MetricIssueTimeline,
  type OrganizationRole,
  type ProjectRole,
} from "@vibe/domain";
import type { PoolClient, QueryResultRow } from "pg";
import { getPool, inTransaction } from "./client";
import { csvLine, validateIssueCsv } from "./csv";

interface AccessRow extends QueryResultRow {
  organization_id: string;
  organization_role: OrganizationRole;
  project_id: string;
  project_key: string;
  project_role: ProjectRole | null;
}

export interface ProjectAccess {
  organizationId: string;
  organizationRole: OrganizationRole;
  projectId: string;
  projectKey: string;
  projectRole: ProjectRole | null;
}

interface IssueRow extends QueryResultRow {
  id: string;
  issue_number: number;
  issue_key: string;
  summary: string;
  description: string | null;
  priority: Priority;
  issue_type: IssueType;
  status_id: string;
  rank: string;
  version: number;
  reporter_id: string;
  reporter_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  labels: string[];
  estimate_points: number | null;
  due_date: string | null;
  parent_id: string | null;
  parent_issue_key: string | null;
  parent_summary: string | null;
  parent_issue_type: IssueType | null;
  epic_id: string | null;
  epic_issue_key: string | null;
  epic_summary: string | null;
  updated_at: Date;
}

export interface PageOptions {
  cursor?: string | undefined;
  limit: number;
}

export interface IdempotencyRequest {
  key: string;
  requestHash: string;
}

interface CursorPayload {
  version: 1;
  kind: string;
  values: Array<string | number>;
}

function encodeCursor(kind: string, values: Array<string | number>): string {
  const payload: CursorPayload = { version: 1, kind, values };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string, kind: string): CursorPayload["values"] {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      parsed.version !== 1 ||
      parsed.kind !== kind ||
      !Array.isArray(parsed.values)
    ) {
      throw new Error("Cursor shape does not match");
    }
    return parsed.values;
  } catch {
    throw new DomainError(
      "INVALID_CURSOR",
      "The pagination cursor is invalid or expired",
      400,
    );
  }
}

async function claimIdempotency<T>(
  client: PoolClient,
  identity: UserIdentity,
  operation: string,
  request: IdempotencyRequest,
): Promise<T | null> {
  const claimed = await client.query(
    `INSERT INTO idempotency_records
      (organization_id, actor_id, operation, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [
      identity.organizationId,
      identity.id,
      operation,
      request.key,
      request.requestHash,
    ],
  );
  if (claimed.rowCount === 1) return null;

  const existing = await client.query<{
    request_hash: string;
    response_body: T | null;
  }>(
    `SELECT request_hash, response_body
       FROM idempotency_records
      WHERE organization_id = $1 AND actor_id = $2
        AND operation = $3 AND idempotency_key = $4
      FOR UPDATE`,
    [identity.organizationId, identity.id, operation, request.key],
  );
  const record = existing.rows[0];
  if (!record) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency request could not be resolved",
      409,
    );
  }
  if (record.request_hash !== request.requestHash) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_REUSED",
      "That Idempotency-Key was already used with a different request",
      409,
    );
  }
  if (!record.response_body) {
    throw new DomainError(
      "IDEMPOTENCY_IN_PROGRESS",
      "A request with that Idempotency-Key is still in progress",
      409,
    );
  }
  return record.response_body;
}

async function completeIdempotency(
  client: PoolClient,
  identity: UserIdentity,
  operation: string,
  request: IdempotencyRequest,
  response: unknown,
): Promise<void> {
  const completed = await client.query(
    `UPDATE idempotency_records
        SET response_body = $1
      WHERE organization_id = $2 AND actor_id = $3
        AND operation = $4 AND idempotency_key = $5`,
    [
      JSON.stringify(response),
      identity.organizationId,
      identity.id,
      operation,
      request.key,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency request could not be completed",
      409,
    );
  }
}

function toAccess(row: AccessRow): ProjectAccess {
  return {
    organizationId: row.organization_id,
    organizationRole: row.organization_role,
    projectId: row.project_id,
    projectKey: row.project_key,
    projectRole: row.project_role,
  };
}

export async function findUserForLogin(email: string): Promise<{
  id: string;
  passwordHash: string;
  state: string;
} | null> {
  const result = await getPool().query<{
    id: string;
    password_hash: string;
    state: string;
  }>(
    "SELECT id, password_hash, state FROM users WHERE lower(email) = lower($1) LIMIT 1",
    [email],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, passwordHash: row.password_hash, state: row.state }
    : null;
}

export async function getIdentity(
  userId: string,
): Promise<UserIdentity | null> {
  const result = await getPool().query<{
    id: string;
    organization_id: string;
    email: string;
    display_name: string;
    organization_role: OrganizationRole;
  }>(
    `SELECT u.id, u.organization_id, u.email, u.display_name, m.organization_role
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.organization_id = u.organization_id
      WHERE u.id = $1 AND u.state = 'ACTIVE'`,
    [userId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        organizationId: row.organization_id,
        email: row.email,
        displayName: row.display_name,
        organizationRole: row.organization_role,
      }
    : null;
}

export async function completeOidcLogin(input: {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
  autoProvision: boolean;
  correlationId: string;
}): Promise<string> {
  return inTransaction(async (client) => {
    const bySubject = await client.query<{
      id: string;
      organization_id: string;
      state: AdministrationUserView["state"];
    }>(
      `SELECT id, organization_id, state FROM users
        WHERE oidc_issuer = $1 AND oidc_subject = $2
        FOR UPDATE`,
      [input.issuer, input.subject],
    );
    let user = bySubject.rows[0];
    let action = "user.oidc_login";
    if (!user) {
      const byEmail = await client.query<{
        id: string;
        organization_id: string;
        state: AdministrationUserView["state"];
      }>(
        `SELECT id, organization_id, state FROM users
          WHERE lower(email) = lower($1)
          FOR UPDATE`,
        [input.email],
      );
      if (byEmail.rows.length > 1) {
        throw new DomainError(
          "OIDC_IDENTITY_AMBIGUOUS",
          "The identity email is ambiguous across organizations",
          403,
        );
      }
      user = byEmail.rows[0];
      if (user) {
        await client.query(
          `UPDATE users SET oidc_issuer = $1, oidc_subject = $2,
                            version = version + 1
            WHERE id = $3`,
          [input.issuer, input.subject, user.id],
        );
        action = "user.oidc_linked";
      } else if (input.autoProvision) {
        const organizations = await client.query<{ id: string }>(
          "SELECT id FROM organizations ORDER BY created_at, id LIMIT 2",
        );
        if (organizations.rows.length !== 1 || !organizations.rows[0]) {
          throw new DomainError(
            "OIDC_PROVISIONING_UNAVAILABLE",
            "Automatic provisioning requires exactly one organization",
            403,
          );
        }
        const userId = randomUUID();
        const organizationId = organizations.rows[0].id;
        await client.query(
          `INSERT INTO users
            (id, organization_id, email, display_name, password_hash, state,
             oidc_issuer, oidc_subject)
           VALUES ($1, $2, lower($3), $4, '!oidc', 'ACTIVE', $5, $6)`,
          [
            userId,
            organizationId,
            input.email,
            input.displayName,
            input.issuer,
            input.subject,
          ],
        );
        await client.query(
          `INSERT INTO memberships (organization_id, user_id, organization_role)
           VALUES ($1, $2, 'MEMBER')`,
          [organizationId, userId],
        );
        user = { id: userId, organization_id: organizationId, state: "ACTIVE" };
        action = "user.oidc_provisioned";
      } else {
        throw new DomainError(
          "OIDC_USER_NOT_INVITED",
          "Ask an administrator to invite this email before signing in",
          403,
        );
      }
    }
    if (user.state === "INACTIVE") {
      throw new DomainError(
        "ACCOUNT_INACTIVE",
        "This account has been deactivated",
        403,
      );
    }
    if (user.state === "INVITED") {
      await client.query(
        `UPDATE users SET state = 'ACTIVE', version = version + 1
          WHERE id = $1`,
        [user.id],
      );
      await client.query(
        `UPDATE user_invitations SET accepted_at = now()
          WHERE user_id = $1 AND accepted_at IS NULL`,
        [user.id],
      );
      action = "user.oidc_activated";
    }
    const auditId = randomUUID();
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, $4, 'user', $3, $5, $6)`,
      [
        auditId,
        user.organization_id,
        user.id,
        action,
        JSON.stringify({ issuer: input.issuer }),
        input.correlationId,
      ],
    );
    return user.id;
  });
}

export async function listProjects(
  identity: UserIdentity,
): Promise<ProjectSummary[]> {
  const result = await getPool().query<{
    id: string;
    project_key: string;
    name: string;
    board_id: string;
  }>(
    `SELECT p.id, p.project_key, p.name, b.id AS board_id
       FROM projects p
       JOIN boards b ON b.project_id = p.id
       LEFT JOIN effective_project_members pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.organization_id = $1
        AND p.archived_at IS NULL
        AND ($3 = 'ADMIN' OR pm.user_id IS NOT NULL)
      ORDER BY p.name, p.id`,
    [identity.organizationId, identity.id, identity.organizationRole],
  );
  return result.rows.map((row) => ({
    id: row.id,
    key: row.project_key,
    name: row.name,
    boardId: row.board_id,
  }));
}

export async function listProjectsPage(
  identity: UserIdentity,
  options: PageOptions,
): Promise<Page<ProjectSummary>> {
  const cursorValues = options.cursor
    ? decodeCursor(options.cursor, "projects")
    : null;
  if (
    cursorValues &&
    (cursorValues.length !== 2 ||
      typeof cursorValues[0] !== "string" ||
      typeof cursorValues[1] !== "string")
  ) {
    throw new DomainError(
      "INVALID_CURSOR",
      "The pagination cursor is invalid or expired",
      400,
    );
  }
  const limit = Math.min(Math.max(Math.trunc(options.limit), 1), 100);
  const values: unknown[] = [
    identity.organizationId,
    identity.id,
    identity.organizationRole,
  ];
  let cursorSql = "";
  if (cursorValues) {
    values.push(cursorValues[0], cursorValues[1]);
    cursorSql = "AND (p.name, p.id) > ($4, $5)";
  }
  values.push(limit + 1);
  const result = await getPool().query<{
    id: string;
    project_key: string;
    name: string;
    board_id: string;
  }>(
    `SELECT p.id, p.project_key, p.name, b.id AS board_id
       FROM projects p
       JOIN boards b ON b.project_id = p.id
       LEFT JOIN effective_project_members pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.organization_id = $1
        AND p.archived_at IS NULL
        AND ($3 = 'ADMIN' OR pm.user_id IS NOT NULL)
        ${cursorSql}
      ORDER BY p.name, p.id
      LIMIT $${values.length}`,
    values,
  );
  const hasNextPage = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({
      id: row.id,
      key: row.project_key,
      name: row.name,
      boardId: row.board_id,
    })),
    nextCursor:
      hasNextPage && last
        ? encodeCursor("projects", [last.name, last.id])
        : null,
  };
}

interface IssueSearchRow extends QueryResultRow {
  id: string;
  issue_key: string;
  summary: string;
  description: string | null;
  priority: Priority;
  issue_type: IssueType;
  rank: string;
  created_at: Date;
  updated_at: Date;
  project_id: string;
  project_key: string;
  project_name: string;
  board_id: string;
  status_id: string;
  status_name: string;
  status_category: StatusView["category"];
  status_color: string;
  status_position: number;
  reporter_id: string;
  reporter_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  labels: string[];
  parent_id: string | null;
  parent_key: string | null;
  parent_summary: string | null;
  relevance: number;
  sort_value: string;
  issue_number: number;
}

function issueSearchKey(query: IssueSearchQuery): string {
  return JSON.stringify({
    q: query.q,
    projects: query.projects,
    issueTypes: query.issueTypes,
    statuses: query.statuses,
    statusCategories: query.statusCategories,
    priorities: query.priorities,
    assignees: query.assignees,
    reporters: query.reporters,
    labels: query.labels,
    parents: query.parents,
    createdFrom: query.createdFrom ?? null,
    createdTo: query.createdTo ?? null,
    updatedFrom: query.updatedFrom ?? null,
    updatedTo: query.updatedTo ?? null,
    sort: query.sort,
    direction: query.direction ?? null,
  });
}

async function issueSearchFacets(
  identity: UserIdentity,
): Promise<IssueSearchFacets> {
  const pool = getPool();
  const accessValues = [
    identity.organizationId,
    identity.id,
    identity.organizationRole,
  ];
  const [projects, statuses, users] = await Promise.all([
    pool.query<{
      id: string;
      project_key: string;
      name: string;
      board_id: string;
    }>(
      `SELECT p.id, p.project_key, p.name, b.id AS board_id
         FROM projects p
         JOIN boards b ON b.project_id = p.id AND b.organization_id = p.organization_id
         LEFT JOIN effective_project_members pm ON pm.project_id = p.id AND pm.user_id = $2
        WHERE p.organization_id = $1 AND p.archived_at IS NULL
          AND ($3 = 'ADMIN' OR pm.user_id IS NOT NULL)
        ORDER BY p.name, p.id`,
      accessValues,
    ),
    pool.query<{
      id: string;
      name: string;
      category: StatusView["category"];
      color: string;
      position: number;
      project_id: string;
      project_key: string;
    }>(
      `SELECT s.id, s.name, s.category, s.color, s.position,
              p.id AS project_id, p.project_key
         FROM projects p
         JOIN workflows w ON w.project_id = p.id AND w.active
         JOIN statuses s ON s.workflow_id = w.id
         LEFT JOIN effective_project_members pm ON pm.project_id = p.id AND pm.user_id = $2
        WHERE p.organization_id = $1 AND p.archived_at IS NULL
          AND ($3 = 'ADMIN' OR pm.user_id IS NOT NULL)
        ORDER BY p.project_key, s.position, s.id`,
      accessValues,
    ),
    pool.query<{ id: string; display_name: string; email: string }>(
      `WITH accessible_projects AS (
         SELECT p.id
           FROM projects p
           LEFT JOIN effective_project_members pm ON pm.project_id = p.id AND pm.user_id = $2
          WHERE p.organization_id = $1 AND p.archived_at IS NULL
            AND ($3 = 'ADMIN' OR pm.user_id IS NOT NULL)
       ), referenced_users AS (
         SELECT i.reporter_id AS user_id
           FROM issues i JOIN accessible_projects ap ON ap.id = i.project_id
          WHERE i.organization_id = $1 AND i.deleted_at IS NULL
         UNION
         SELECT i.assignee_id
           FROM issues i JOIN accessible_projects ap ON ap.id = i.project_id
          WHERE i.organization_id = $1 AND i.deleted_at IS NULL
            AND i.assignee_id IS NOT NULL
       )
       SELECT u.id, u.display_name, u.email
         FROM referenced_users ru
         JOIN users u ON u.id = ru.user_id AND u.organization_id = $1
        ORDER BY u.display_name, u.id`,
      accessValues,
    ),
  ]);
  return {
    projects: projects.rows.map((row) => ({
      id: row.id,
      key: row.project_key,
      name: row.name,
      boardId: row.board_id,
    })),
    statuses: statuses.rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      color: row.color,
      position: row.position,
      projectId: row.project_id,
      projectKey: row.project_key,
    })),
    users: users.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      email: row.email,
    })),
  };
}

export async function searchIssues(
  identity: UserIdentity,
  query: IssueSearchQuery,
): Promise<IssueSearchPage> {
  const values: unknown[] = [
    identity.organizationId,
    identity.id,
    identity.organizationRole,
  ];
  const parameter = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const predicates = [
    "i.organization_id = $1",
    "i.deleted_at IS NULL",
    "p.archived_at IS NULL",
    "($3 = 'ADMIN' OR search_pm.user_id IS NOT NULL)",
  ];
  let relevanceSql = "0::real";
  if (query.q) {
    const q = parameter(query.q);
    relevanceSql = `ts_rank_cd(i.search_vector, websearch_to_tsquery('simple', ${q}))`;
    predicates.push(
      `(i.search_vector @@ websearch_to_tsquery('simple', ${q}) OR
        lower(p.project_key || '-' || i.number::text) LIKE '%' || lower(${q}) || '%')`,
    );
  }
  if (query.projects.length > 0) {
    predicates.push(
      `p.project_key = ANY(${parameter(query.projects)}::text[])`,
    );
  }
  if (query.issueTypes.length > 0) {
    predicates.push(
      `upper(it.name) = ANY(${parameter(query.issueTypes)}::text[])`,
    );
  }
  if (query.statuses.length > 0) {
    predicates.push(`i.status_id = ANY(${parameter(query.statuses)}::uuid[])`);
  }
  if (query.statusCategories.length > 0) {
    predicates.push(
      `s.category = ANY(${parameter(query.statusCategories)}::text[])`,
    );
  }
  if (query.priorities.length > 0) {
    predicates.push(`i.priority = ANY(${parameter(query.priorities)}::text[])`);
  }
  if (query.assignees.length > 0) {
    const includeUnassigned = query.assignees.includes("unassigned");
    const assignedIds = query.assignees.filter(
      (assignee) => assignee !== "unassigned",
    );
    const assigned =
      assignedIds.length > 0
        ? `i.assignee_id = ANY(${parameter(assignedIds)}::uuid[])`
        : "false";
    predicates.push(
      includeUnassigned ? `(${assigned} OR i.assignee_id IS NULL)` : assigned,
    );
  }
  if (query.reporters.length > 0) {
    predicates.push(
      `i.reporter_id = ANY(${parameter(query.reporters)}::uuid[])`,
    );
  }
  if (query.labels.length > 0) {
    const normalizedLabels = query.labels.map((label) =>
      label.replace(/\s+/g, " ").toLocaleLowerCase(),
    );
    predicates.push(
      `EXISTS (
         SELECT 1 FROM issue_labels search_il
         JOIN labels search_label ON search_label.id = search_il.label_id
          AND search_label.organization_id = search_il.organization_id
        WHERE search_il.organization_id = i.organization_id
          AND search_il.issue_id = i.id
          AND search_label.normalized_name = ANY(${parameter(normalizedLabels)}::text[])
       )`,
    );
  }
  if (query.parents.length > 0) {
    predicates.push(
      `(p.project_key || '-' || parent.number::text) = ANY(${parameter(query.parents)}::text[])`,
    );
  }
  if (query.createdFrom) {
    predicates.push(`i.created_at >= ${parameter(query.createdFrom)}::date`);
  }
  if (query.createdTo) {
    predicates.push(
      `i.created_at < ${parameter(query.createdTo)}::date + interval '1 day'`,
    );
  }
  if (query.updatedFrom) {
    predicates.push(`i.updated_at >= ${parameter(query.updatedFrom)}::date`);
  }
  if (query.updatedTo) {
    predicates.push(
      `i.updated_at < ${parameter(query.updatedTo)}::date + interval '1 day'`,
    );
  }

  const effectiveSort =
    query.sort === "relevance" && !query.q ? "updated" : query.sort;
  const direction =
    query.direction ??
    (effectiveSort === "rank" || effectiveSort === "key" ? "asc" : "desc");
  const sortExpressions = {
    relevance: relevanceSql,
    rank: "i.rank",
    priority:
      "CASE i.priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END",
    created: "i.created_at",
    updated: "i.updated_at",
    key: "p.project_key",
  } as const;
  const sortCasts = {
    relevance: "real",
    rank: "numeric",
    priority: "integer",
    created: "timestamptz",
    updated: "timestamptz",
    key: "text",
  } as const;
  const sortExpression = sortExpressions[effectiveSort];
  const cursorKind = `issue-search:${issueSearchKey(query)}:${effectiveSort}:${direction}`;
  const cursorValues = query.cursor
    ? decodeCursor(query.cursor, cursorKind)
    : null;
  if (
    cursorValues &&
    (cursorValues.length !== 4 ||
      typeof cursorValues[0] !== "string" ||
      typeof cursorValues[1] !== "string" ||
      typeof cursorValues[2] !== "number" ||
      !Number.isInteger(cursorValues[2]) ||
      typeof cursorValues[3] !== "string")
  ) {
    throw new DomainError(
      "INVALID_CURSOR",
      "The pagination cursor is invalid or expired",
      400,
    );
  }
  if (cursorValues) {
    const primary = parameter(cursorValues[0]);
    const projectKey = parameter(cursorValues[1]);
    const number = parameter(cursorValues[2]);
    const id = parameter(cursorValues[3]);
    predicates.push(
      `(${sortExpression}, p.project_key, i.number, i.id) ${direction === "asc" ? ">" : "<"}
       (${primary}::${sortCasts[effectiveSort]}, ${projectKey}::text, ${number}::integer, ${id}::uuid)`,
    );
  }
  const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);
  const limitParameter = parameter(limit + 1);
  const result = await getPool().query<IssueSearchRow>(
    `SELECT i.id, p.project_key || '-' || i.number AS issue_key,
            i.number AS issue_number, i.summary, i.description, i.priority,
            upper(it.name)::text AS issue_type, i.rank::text, i.created_at, i.updated_at,
            p.id AS project_id, p.project_key, p.name AS project_name, b.id AS board_id,
            s.id AS status_id, s.name AS status_name, s.category AS status_category,
            s.color AS status_color, s.position AS status_position,
            reporter.id AS reporter_id, reporter.display_name AS reporter_name,
            assignee.id AS assignee_id, assignee.display_name AS assignee_name,
            ARRAY(
              SELECT label.display_name
                FROM issue_labels il
                JOIN labels label ON label.id = il.label_id
                 AND label.organization_id = il.organization_id
               WHERE il.organization_id = i.organization_id AND il.issue_id = i.id
               ORDER BY label.normalized_name
            ) AS labels,
            parent.id AS parent_id,
            CASE WHEN parent.id IS NULL THEN NULL
                 ELSE p.project_key || '-' || parent.number END AS parent_key,
            parent.summary AS parent_summary,
            ${relevanceSql} AS relevance,
            (${sortExpression})::text AS sort_value
       FROM issues i
       JOIN projects p ON p.id = i.project_id AND p.organization_id = i.organization_id
       JOIN boards b ON b.project_id = p.id AND b.organization_id = p.organization_id
       JOIN issue_types it ON it.id = i.issue_type_id
       JOIN statuses s ON s.id = i.status_id
       JOIN users reporter ON reporter.id = i.reporter_id
       LEFT JOIN users assignee ON assignee.id = i.assignee_id
       LEFT JOIN issues parent ON parent.id = i.parent_id
        AND parent.organization_id = i.organization_id AND parent.deleted_at IS NULL
       LEFT JOIN effective_project_members search_pm
         ON search_pm.project_id = p.id AND search_pm.user_id = $2
      WHERE ${predicates.join(" AND ")}
      ORDER BY ${sortExpression} ${direction}, p.project_key ${direction},
               i.number ${direction}, i.id ${direction}
      LIMIT ${limitParameter}`,
    values,
  );
  const hasNextPage = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const items: IssueSearchItem[] = rows.map((row) => ({
    id: row.id,
    key: row.issue_key,
    summary: row.summary,
    description: row.description ?? "",
    priority: row.priority,
    issueType: row.issue_type,
    project: {
      id: row.project_id,
      key: row.project_key,
      name: row.project_name,
      boardId: row.board_id,
    },
    status: {
      id: row.status_id,
      name: row.status_name,
      category: row.status_category,
      color: row.status_color,
      position: row.status_position,
    },
    reporter: { id: row.reporter_id, displayName: row.reporter_name },
    assignee:
      row.assignee_id && row.assignee_name
        ? { id: row.assignee_id, displayName: row.assignee_name }
        : null,
    labels: row.labels,
    parent:
      row.parent_id && row.parent_key && row.parent_summary
        ? {
            id: row.parent_id,
            key: row.parent_key,
            summary: row.parent_summary,
          }
        : null,
    rank: row.rank,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    relevance: Number(row.relevance),
  }));
  const last = result.rows[Math.min(rows.length, limit) - 1];
  return {
    items,
    nextCursor:
      hasNextPage && last
        ? encodeCursor(cursorKind, [
            last.sort_value,
            last.project_key,
            last.issue_number,
            last.id,
          ])
        : null,
    facets: await issueSearchFacets(identity),
  };
}

interface SavedFilterRow extends QueryResultRow {
  id: string;
  name: string;
  visibility: SavedFilterVisibility;
  owner_id: string;
  owner_name: string;
  project_id: string | null;
  project_key: string | null;
  project_name: string | null;
  board_id: string | null;
  query_json: unknown;
  is_quick: boolean;
  position: number | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  viewer_project_role: ProjectRole | null;
}

function savedFilterQuery(query: IssueSearchQuery): SavedFilterQuery {
  return {
    q: query.q,
    projects: query.projects,
    issueTypes: query.issueTypes,
    statuses: query.statuses,
    statusCategories: query.statusCategories,
    priorities: query.priorities,
    assignees: query.assignees,
    reporters: query.reporters,
    labels: query.labels,
    parents: query.parents,
    ...(query.createdFrom ? { createdFrom: query.createdFrom } : {}),
    ...(query.createdTo ? { createdTo: query.createdTo } : {}),
    ...(query.updatedFrom ? { updatedFrom: query.updatedFrom } : {}),
    ...(query.updatedTo ? { updatedTo: query.updatedTo } : {}),
    sort: query.sort,
    ...(query.direction ? { direction: query.direction } : {}),
  };
}

function parseSavedFilterQuery(value: unknown): SavedFilterQuery {
  return savedFilterQuery(
    // Imported schema validation is intentionally mirrored through the search
    // entrypoint so stored JSON can never bypass current query validation.
    issueSearchQueryFromStored(value),
  );
}

function issueSearchQueryFromStored(value: unknown): IssueSearchQuery {
  try {
    return issueSearchQuerySchema.parse({
      ...(value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {}),
      limit: 25,
    });
  } catch {
    throw new DomainError(
      "INVALID_SAVED_FILTER",
      "The saved filter query is invalid",
      500,
    );
  }
}

function savedFilterCanEdit(
  identity: UserIdentity,
  row: SavedFilterRow,
): boolean {
  if (identity.organizationRole === "ADMIN") return true;
  if (row.visibility === "PRIVATE") return row.owner_id === identity.id;
  return row.visibility === "PROJECT" && row.viewer_project_role === "ADMIN";
}

function toSavedFilter(
  identity: UserIdentity,
  row: SavedFilterRow,
): SavedFilterView {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    owner: { id: row.owner_id, displayName: row.owner_name },
    project:
      row.project_id && row.project_key && row.project_name && row.board_id
        ? {
            id: row.project_id,
            key: row.project_key,
            name: row.project_name,
            boardId: row.board_id,
          }
        : null,
    query: parseSavedFilterQuery(row.query_json),
    isQuick: row.is_quick,
    position: row.position,
    version: row.version,
    canEdit: savedFilterCanEdit(identity, row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const savedFilterSelect = `SELECT sf.id, sf.name, sf.visibility, sf.owner_id,
       owner.display_name AS owner_name, sf.project_id, p.project_key,
       p.name AS project_name, b.id AS board_id, sf.query_json, sf.is_quick,
       sf.position, sf.version, sf.created_at, sf.updated_at,
       viewer_pm.role AS viewer_project_role
  FROM saved_filters sf
  JOIN users owner ON owner.id = sf.owner_id AND owner.organization_id = sf.organization_id
  LEFT JOIN projects p ON p.id = sf.project_id AND p.organization_id = sf.organization_id
  LEFT JOIN boards b ON b.project_id = p.id AND b.organization_id = p.organization_id
  LEFT JOIN effective_project_members viewer_pm
    ON viewer_pm.project_id = sf.project_id AND viewer_pm.user_id = $2`;

export async function listSavedFilters(
  identity: UserIdentity,
  projectKey?: string,
): Promise<SavedFilterView[]> {
  const values: unknown[] = [
    identity.organizationId,
    identity.id,
    identity.organizationRole === "ADMIN",
  ];
  let projectPredicate = "";
  if (projectKey) {
    values.push(projectKey);
    projectPredicate = `AND (sf.project_id IS NULL OR p.project_key = $${values.length})`;
  }
  const result = await getPool().query<SavedFilterRow>(
    `${savedFilterSelect}
     WHERE sf.organization_id = $1
       AND (
         sf.owner_id = $2 OR sf.visibility = 'ORGANIZATION' OR
         (sf.visibility = 'PROJECT' AND ($3::boolean OR viewer_pm.user_id IS NOT NULL))
       )
       ${projectPredicate}
     ORDER BY sf.is_quick DESC, coalesce(sf.position, 2147483647), sf.name, sf.id`,
    values,
  );
  return result.rows.map((row) => toSavedFilter(identity, row));
}

export async function getSavedFilter(
  identity: UserIdentity,
  filterId: string,
): Promise<SavedFilterView | null> {
  const result = await getPool().query<SavedFilterRow>(
    `${savedFilterSelect}
     WHERE sf.organization_id = $1 AND sf.id = $3
       AND (
         sf.owner_id = $2 OR sf.visibility = 'ORGANIZATION' OR
         (sf.visibility = 'PROJECT' AND ($4::boolean OR viewer_pm.user_id IS NOT NULL))
       )
     LIMIT 1`,
    [
      identity.organizationId,
      identity.id,
      filterId,
      identity.organizationRole === "ADMIN",
    ],
  );
  return result.rows[0] ? toSavedFilter(identity, result.rows[0]) : null;
}

function assertQuickFilterQuery(
  query: SavedFilterQuery,
  projectKey: string,
): void {
  const supported =
    (query.projects.length === 0 ||
      (query.projects.length === 1 && query.projects[0] === projectKey)) &&
    query.issueTypes.length <= 1 &&
    query.priorities.length <= 1 &&
    query.assignees.length <= 1 &&
    query.labels.length <= 1 &&
    query.statuses.length === 0 &&
    query.statusCategories.length === 0 &&
    query.reporters.length === 0 &&
    query.parents.length === 0 &&
    !query.createdFrom &&
    !query.createdTo &&
    !query.updatedFrom &&
    !query.updatedTo;
  if (!supported) {
    throw new DomainError(
      "QUICK_FILTER_UNSUPPORTED",
      "Quick filters support text, one type, one priority, one assignee, and one label",
      422,
    );
  }
}

async function savedFilterProject(
  identity: UserIdentity,
  projectKey: string | null,
): Promise<ProjectAccess | null> {
  if (!projectKey) return null;
  const access = await getProjectAccess(identity.id, projectKey);
  if (
    !access ||
    access.organizationId !== identity.organizationId ||
    !can(access.organizationRole, access.projectRole, "issue:view")
  ) {
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  }
  return access;
}

function assertSavedFilterAuthority(
  identity: UserIdentity,
  access: ProjectAccess | null,
  visibility: SavedFilterVisibility,
  isQuick: boolean,
): void {
  if (visibility === "PRIVATE") {
    if (isQuick) {
      throw new DomainError(
        "INVALID_QUICK_FILTER",
        "A board quick filter must be shared with a project",
        422,
      );
    }
    if (access) {
      assertCapability(
        access.organizationRole,
        access.projectRole,
        "filter:create",
      );
    }
    return;
  }
  if (visibility === "ORGANIZATION") {
    if (identity.organizationRole !== "ADMIN") {
      throw new DomainError(
        "FORBIDDEN",
        "Only organization administrators can share organization filters",
        403,
      );
    }
    if (isQuick) {
      throw new DomainError(
        "INVALID_QUICK_FILTER",
        "A board quick filter must be shared with a project",
        422,
      );
    }
    return;
  }
  if (!access) {
    throw new DomainError(
      "PROJECT_REQUIRED",
      "Project-shared filters require a project",
      422,
    );
  }
  assertCapability(
    access.organizationRole,
    access.projectRole,
    "filter:manage-shared",
  );
}

async function recordSavedFilterMutation(
  client: PoolClient,
  identity: UserIdentity,
  filterId: string,
  action: "created" | "updated" | "deleted",
  metadata: Record<string, unknown>,
  correlationIdValue: string,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, metadata, correlation_id)
     VALUES ($1, $2, $3, $4, 'saved_filter', $5, $6, $7)`,
    [
      randomUUID(),
      identity.organizationId,
      identity.id,
      `filter.${action}`,
      filterId,
      JSON.stringify(metadata),
      correlationIdValue,
    ],
  );
  await client.query(
    `INSERT INTO outbox_events
      (id, organization_id, topic, aggregate_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomUUID(),
      identity.organizationId,
      `filter.${action}`,
      filterId,
      JSON.stringify({
        filterId,
        ...metadata,
        correlationId: correlationIdValue,
      }),
    ],
  );
}

export async function createSavedFilter(
  identity: UserIdentity,
  input: CreateSavedFilterInput,
  requestCorrelationId: string = randomUUID(),
): Promise<SavedFilterView> {
  const access = await savedFilterProject(identity, input.projectKey);
  assertSavedFilterAuthority(identity, access, input.visibility, input.isQuick);
  let query = savedFilterQuery(input.query);
  if (input.visibility === "PROJECT" && access) {
    query = { ...query, projects: [access.projectKey] };
  }
  if (input.isQuick && access) assertQuickFilterQuery(query, access.projectKey);
  const filterId = randomUUID();
  await inTransaction(async (client) => {
    let position: number | null = null;
    if (input.isQuick && access) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `saved-filter:${access.projectId}`,
      ]);
      const next = await client.query<{ position: number }>(
        `SELECT coalesce(max(position), -1) + 1 AS position
           FROM saved_filters WHERE project_id = $1 AND is_quick`,
        [access.projectId],
      );
      position = next.rows[0]?.position ?? 0;
    }
    await client.query(
      `INSERT INTO saved_filters
        (id, organization_id, project_id, owner_id, name, visibility,
         query_json, is_quick, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        filterId,
        identity.organizationId,
        access?.projectId ?? null,
        identity.id,
        input.name,
        input.visibility,
        JSON.stringify(query),
        input.isQuick,
        position,
      ],
    );
    await recordSavedFilterMutation(
      client,
      identity,
      filterId,
      "created",
      { visibility: input.visibility, projectId: access?.projectId ?? null },
      requestCorrelationId,
    );
  });
  const created = await getSavedFilter(identity, filterId);
  if (!created) {
    throw new DomainError("FILTER_NOT_FOUND", "Saved filter not found", 500);
  }
  return created;
}

export async function updateSavedFilter(
  identity: UserIdentity,
  filterId: string,
  input: UpdateSavedFilterInput,
  requestCorrelationId: string = randomUUID(),
): Promise<SavedFilterView> {
  const existing = await getSavedFilter(identity, filterId);
  if (!existing) {
    throw new DomainError("FILTER_NOT_FOUND", "Saved filter not found", 404);
  }
  if (!existing.canEdit) {
    throw new DomainError(
      "FORBIDDEN",
      "You cannot edit this saved filter",
      403,
    );
  }
  const access = await savedFilterProject(identity, input.projectKey);
  assertSavedFilterAuthority(identity, access, input.visibility, input.isQuick);
  let query = savedFilterQuery(input.query);
  if (input.visibility === "PROJECT" && access) {
    query = { ...query, projects: [access.projectKey] };
  }
  if (input.isQuick && access) assertQuickFilterQuery(query, access.projectKey);
  await inTransaction(async (client) => {
    if (input.isQuick && access) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `saved-filter:${access.projectId}`,
      ]);
    }
    const current = await client.query<{ version: number }>(
      `SELECT version FROM saved_filters
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [filterId, identity.organizationId],
    );
    const row = current.rows[0];
    if (!row) {
      throw new DomainError("FILTER_NOT_FOUND", "Saved filter not found", 404);
    }
    assertVersion(input.version, row.version);
    let position: number | null = null;
    if (input.isQuick && access) {
      if (existing.isQuick && existing.project?.id === access.projectId) {
        position = existing.position;
      } else {
        const next = await client.query<{ position: number }>(
          `SELECT coalesce(max(position), -1) + 1 AS position
             FROM saved_filters WHERE project_id = $1 AND is_quick AND id <> $2`,
          [access.projectId, filterId],
        );
        position = next.rows[0]?.position ?? 0;
      }
    }
    await client.query(
      `UPDATE saved_filters
          SET project_id = $3, name = $4, visibility = $5, query_json = $6,
              is_quick = $7, position = $8, version = version + 1, updated_at = now()
        WHERE id = $1 AND organization_id = $2`,
      [
        filterId,
        identity.organizationId,
        access?.projectId ?? null,
        input.name,
        input.visibility,
        JSON.stringify(query),
        input.isQuick,
        position,
      ],
    );
    await recordSavedFilterMutation(
      client,
      identity,
      filterId,
      "updated",
      { visibility: input.visibility, projectId: access?.projectId ?? null },
      requestCorrelationId,
    );
  });
  const updated = await getSavedFilter(identity, filterId);
  if (!updated) {
    throw new DomainError("FILTER_NOT_FOUND", "Saved filter not found", 500);
  }
  return updated;
}

export async function deleteSavedFilter(
  identity: UserIdentity,
  filterId: string,
  version: number,
  requestCorrelationId: string = randomUUID(),
): Promise<void> {
  const existing = await getSavedFilter(identity, filterId);
  if (!existing) {
    throw new DomainError("FILTER_NOT_FOUND", "Saved filter not found", 404);
  }
  if (!existing.canEdit) {
    throw new DomainError(
      "FORBIDDEN",
      "You cannot delete this saved filter",
      403,
    );
  }
  await inTransaction(async (client) => {
    const current = await client.query<{ version: number }>(
      `SELECT version FROM saved_filters
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [filterId, identity.organizationId],
    );
    const row = current.rows[0];
    if (!row) {
      throw new DomainError("FILTER_NOT_FOUND", "Saved filter not found", 404);
    }
    assertVersion(version, row.version);
    await client.query(
      "DELETE FROM saved_filters WHERE id = $1 AND organization_id = $2",
      [filterId, identity.organizationId],
    );
    await recordSavedFilterMutation(
      client,
      identity,
      filterId,
      "deleted",
      {
        visibility: existing.visibility,
        projectId: existing.project?.id ?? null,
      },
      requestCorrelationId,
    );
  });
}

export async function listBoardQuickFilters(
  identity: UserIdentity,
  access: ProjectAccess,
): Promise<QuickFilterView[]> {
  assertCapability(access.organizationRole, access.projectRole, "issue:view");
  const result = await getPool().query<{
    id: string;
    name: string;
    query_json: unknown;
  }>(
    `SELECT id, name, query_json
       FROM saved_filters
      WHERE organization_id = $1 AND project_id = $2
        AND visibility = 'PROJECT' AND is_quick
      ORDER BY position, name, id`,
    [access.organizationId, access.projectId],
  );
  return result.rows.map((row) => {
    const query = parseSavedFilterQuery(row.query_json);
    return {
      id: row.id,
      name: row.name,
      query: {
        q: query.q,
        issueType: query.issueTypes[0] ?? "",
        priority: query.priorities[0] ?? "",
        assignee: query.assignees[0] ?? "",
        label: query.labels[0] ?? "",
        epicKey: "",
      },
    };
  });
}

export async function getProjectAccess(
  userId: string,
  projectKey: string,
): Promise<ProjectAccess | null> {
  const result = await getPool().query<AccessRow>(
    `SELECT p.organization_id, m.organization_role, p.id AS project_id,
            p.project_key, pm.role AS project_role
       FROM projects p
       JOIN memberships m ON m.organization_id = p.organization_id AND m.user_id = $1
       LEFT JOIN effective_project_members pm ON pm.project_id = p.id AND pm.user_id = $1
      WHERE p.project_key = $2 AND p.archived_at IS NULL
      LIMIT 1`,
    [userId, projectKey],
  );
  return result.rows[0] ? toAccess(result.rows[0]) : null;
}

interface ProjectMemberRow extends QueryResultRow {
  id: string;
  email: string;
  display_name: string;
  state: ProjectMemberView["state"];
  organization_role: ProjectMemberView["organizationRole"];
  project_role: ProjectRole | null;
}

interface DeletedIssueRow extends QueryResultRow {
  id: string;
  issue_key: string;
  summary: string;
  issue_type: IssueType;
  version: number;
  deleted_at: Date;
  deleted_by_id: string | null;
  deleted_by_name: string | null;
}

function toProjectMember(row: ProjectMemberRow): ProjectMemberView {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    state: row.state,
    organizationRole: row.organization_role,
    projectRole: row.project_role,
  };
}

function assertMembershipAdministration(
  identity: UserIdentity,
  access: ProjectAccess,
): void {
  if (identity.organizationId !== access.organizationId) {
    throw new DomainError(
      "FORBIDDEN",
      "You do not have permission to perform this action",
      403,
    );
  }
  assertCapability(
    access.organizationRole,
    access.projectRole,
    "project:admin",
  );
}

export async function listProjectMembers(
  identity: UserIdentity,
  access: ProjectAccess,
): Promise<ProjectMembersView> {
  assertMembershipAdministration(identity, access);
  const project = await getPool().query<{
    id: string;
    project_key: string;
    name: string;
    board_id: string;
  }>(
    `SELECT p.id, p.project_key, p.name, b.id AS board_id
       FROM projects p
       JOIN boards b ON b.project_id = p.id
      WHERE p.id = $1 AND p.organization_id = $2 AND p.archived_at IS NULL
      ORDER BY b.id
      LIMIT 1`,
    [access.projectId, access.organizationId],
  );
  const projectRow = project.rows[0];
  if (!projectRow) {
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  }
  const members = await getPool().query<ProjectMemberRow>(
    `SELECT u.id, u.email, u.display_name, u.state,
            m.organization_role, pm.role AS project_role
       FROM users u
       JOIN memberships m
         ON m.organization_id = u.organization_id AND m.user_id = u.id
       LEFT JOIN project_members pm
         ON pm.organization_id = u.organization_id
        AND pm.project_id = $2 AND pm.user_id = u.id
      WHERE u.organization_id = $1
      ORDER BY u.display_name, u.id`,
    [access.organizationId, access.projectId],
  );
  return {
    project: {
      id: projectRow.id,
      key: projectRow.project_key,
      name: projectRow.name,
      boardId: projectRow.board_id,
    },
    members: members.rows.map(toProjectMember),
  };
}

export async function listDeletedIssues(
  identity: UserIdentity,
  access: ProjectAccess,
): Promise<DeletedIssuesView> {
  if (identity.organizationId !== access.organizationId) {
    throw new DomainError(
      "FORBIDDEN",
      "You do not have permission to perform this action",
      403,
    );
  }
  assertCapability(
    access.organizationRole,
    access.projectRole,
    "issue:restore",
  );
  const project = await getPool().query<{
    id: string;
    project_key: string;
    name: string;
    board_id: string;
  }>(
    `SELECT p.id, p.project_key, p.name, b.id AS board_id
       FROM projects p
       JOIN boards b ON b.project_id = p.id AND b.organization_id = p.organization_id
      WHERE p.id = $1 AND p.organization_id = $2 AND p.archived_at IS NULL
      ORDER BY b.id
      LIMIT 1`,
    [access.projectId, access.organizationId],
  );
  const projectRow = project.rows[0];
  if (!projectRow) {
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  }
  const deleted = await getPool().query<DeletedIssueRow>(
    `SELECT i.id, p.project_key || '-' || i.number AS issue_key,
            i.summary, upper(it.name)::text AS issue_type, i.version,
            i.deleted_at, deleted_by.id AS deleted_by_id,
            deleted_by.display_name AS deleted_by_name
       FROM issues i
       JOIN projects p ON p.id = i.project_id
       JOIN issue_types it ON it.id = i.issue_type_id
       LEFT JOIN users deleted_by ON deleted_by.id = i.deleted_by
      WHERE i.organization_id = $1 AND i.project_id = $2
        AND i.deleted_at IS NOT NULL
      ORDER BY i.deleted_at DESC, i.id`,
    [access.organizationId, access.projectId],
  );
  return {
    project: {
      id: projectRow.id,
      key: projectRow.project_key,
      name: projectRow.name,
      boardId: projectRow.board_id,
    },
    issues: deleted.rows.map((row): DeletedIssueView => ({
      id: row.id,
      key: row.issue_key,
      summary: row.summary,
      issueType: row.issue_type,
      version: row.version,
      deletedAt: row.deleted_at.toISOString(),
      deletedBy:
        row.deleted_by_id && row.deleted_by_name
          ? { id: row.deleted_by_id, displayName: row.deleted_by_name }
          : null,
    })),
  };
}

async function lockMembershipProject(
  client: PoolClient,
  access: ProjectAccess,
): Promise<void> {
  const project = await client.query(
    `SELECT id FROM projects
      WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL
      FOR UPDATE`,
    [access.projectId, access.organizationId],
  );
  if (!project.rows[0]) {
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  }
}

async function assertAdminRemains(
  client: PoolClient,
  access: ProjectAccess,
): Promise<void> {
  const administrators = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM effective_project_members
      WHERE organization_id = $1 AND project_id = $2 AND role = 'ADMIN'`,
    [access.organizationId, access.projectId],
  );
  if (Number(administrators.rows[0]?.count ?? 0) <= 1) {
    throw new DomainError(
      "LAST_PROJECT_ADMIN",
      "A project must keep at least one project administrator",
      409,
    );
  }
}

async function assertNoActiveAssignments(
  client: PoolClient,
  access: ProjectAccess,
  userId: string,
): Promise<void> {
  const assigned = await client.query(
    `SELECT id FROM issues
      WHERE organization_id = $1 AND project_id = $2
        AND assignee_id = $3 AND deleted_at IS NULL
      LIMIT 1`,
    [access.organizationId, access.projectId, userId],
  );
  if (assigned.rows[0]) {
    throw new DomainError(
      "MEMBER_HAS_ASSIGNED_ISSUES",
      "Reassign this member's active issues before removing their member access",
      409,
    );
  }
}

async function writeMembershipChange(
  client: PoolClient,
  identity: UserIdentity,
  access: ProjectAccess,
  memberId: string,
  fromRole: ProjectRole | null,
  toRole: ProjectRole | null,
  requestCorrelationId: string,
): Promise<void> {
  const action = fromRole
    ? toRole
      ? "project.member_role_changed"
      : "project.member_removed"
    : "project.member_added";
  const metadata = { memberId, fromRole, toRole };
  await client.query(
    `INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id,
       metadata, correlation_id)
     VALUES ($1, $2, $3, $4, 'project', $5, $6, $7)`,
    [
      randomUUID(),
      access.organizationId,
      identity.id,
      action,
      access.projectId,
      JSON.stringify(metadata),
      requestCorrelationId,
    ],
  );
  await client.query(
    `INSERT INTO outbox_events
      (id, organization_id, topic, aggregate_id, payload)
     VALUES ($1, $2, 'project.membership_changed', $3, $4)`,
    [
      randomUUID(),
      access.organizationId,
      access.projectId,
      JSON.stringify({
        projectId: access.projectId,
        actorId: identity.id,
        ...metadata,
        correlationId: requestCorrelationId,
      }),
    ],
  );
}

export async function setProjectMember(
  identity: UserIdentity,
  access: ProjectAccess,
  userId: string,
  role: ProjectRole,
  requestCorrelationId: string = randomUUID(),
): Promise<ProjectMemberView> {
  assertMembershipAdministration(identity, access);
  return inTransaction(async (client) => {
    await lockMembershipProject(client, access);
    const target = await client.query<ProjectMemberRow>(
      `SELECT u.id, u.email, u.display_name, u.state,
              m.organization_role, pm.role AS project_role
         FROM users u
         JOIN memberships m
           ON m.organization_id = u.organization_id AND m.user_id = u.id
         LEFT JOIN project_members pm
           ON pm.organization_id = u.organization_id
          AND pm.project_id = $2 AND pm.user_id = u.id
        WHERE u.organization_id = $1 AND u.id = $3
        FOR UPDATE OF u`,
      [access.organizationId, access.projectId, userId],
    );
    const member = target.rows[0];
    if (!member) {
      throw new DomainError(
        "ORGANIZATION_MEMBER_NOT_FOUND",
        "Organization member not found",
        404,
      );
    }
    if (member.state !== "ACTIVE") {
      throw new DomainError(
        "USER_INACTIVE",
        "Inactive users cannot be granted project access",
        409,
      );
    }
    if (member.project_role === role) return toProjectMember(member);
    if (member.project_role === "ADMIN" && role !== "ADMIN") {
      await assertAdminRemains(client, access);
    }
    if (role === "VIEWER") {
      await assertNoActiveAssignments(client, access, userId);
    }

    await client.query(
      `INSERT INTO project_members
        (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, user_id)
       DO UPDATE SET role = EXCLUDED.role`,
      [access.organizationId, access.projectId, userId, role],
    );
    await writeMembershipChange(
      client,
      identity,
      access,
      userId,
      member.project_role,
      role,
      requestCorrelationId,
    );
    return toProjectMember({ ...member, project_role: role });
  });
}

export async function removeProjectMember(
  identity: UserIdentity,
  access: ProjectAccess,
  userId: string,
  requestCorrelationId: string = randomUUID(),
): Promise<void> {
  assertMembershipAdministration(identity, access);
  await inTransaction(async (client) => {
    await lockMembershipProject(client, access);
    const current = await client.query<{ role: ProjectRole }>(
      `SELECT role FROM project_members
        WHERE organization_id = $1 AND project_id = $2 AND user_id = $3
        FOR UPDATE`,
      [access.organizationId, access.projectId, userId],
    );
    const role = current.rows[0]?.role;
    if (!role) {
      throw new DomainError(
        "PROJECT_MEMBER_NOT_FOUND",
        "Project member not found",
        404,
      );
    }
    if (role === "ADMIN") await assertAdminRemains(client, access);
    await assertNoActiveAssignments(client, access, userId);
    await client.query(
      `DELETE FROM project_members
        WHERE organization_id = $1 AND project_id = $2 AND user_id = $3`,
      [access.organizationId, access.projectId, userId],
    );
    await writeMembershipChange(
      client,
      identity,
      access,
      userId,
      role,
      null,
      requestCorrelationId,
    );
  });
}

export async function getBoardAccess(
  userId: string,
  boardId: string,
): Promise<ProjectAccess | null> {
  const result = await getPool().query<AccessRow>(
    `SELECT p.organization_id, m.organization_role, p.id AS project_id,
            p.project_key, pm.role AS project_role
       FROM boards b
       JOIN projects p ON p.id = b.project_id
       JOIN memberships m ON m.organization_id = p.organization_id AND m.user_id = $1
       LEFT JOIN effective_project_members pm ON pm.project_id = p.id AND pm.user_id = $1
      WHERE b.id = $2 AND p.archived_at IS NULL
      LIMIT 1`,
    [userId, boardId],
  );
  return result.rows[0] ? toAccess(result.rows[0]) : null;
}

export async function getIssueAccess(
  userId: string,
  issueKey: string,
): Promise<ProjectAccess | null> {
  const [projectKey, rawNumber] = splitIssueKey(issueKey);
  if (!projectKey || !rawNumber) return null;
  const result = await getPool().query<AccessRow>(
    `SELECT p.organization_id, m.organization_role, p.id AS project_id,
            p.project_key, pm.role AS project_role
       FROM issues i
       JOIN projects p ON p.id = i.project_id
       JOIN memberships m ON m.organization_id = p.organization_id AND m.user_id = $1
       LEFT JOIN effective_project_members pm ON pm.project_id = p.id AND pm.user_id = $1
      WHERE p.project_key = $2 AND i.number = $3 AND i.deleted_at IS NULL
      LIMIT 1`,
    [userId, projectKey, rawNumber],
  );
  return result.rows[0] ? toAccess(result.rows[0]) : null;
}

export async function getDeletedIssueAccess(
  userId: string,
  issueKey: string,
): Promise<ProjectAccess | null> {
  const [projectKey, rawNumber] = splitIssueKey(issueKey);
  if (!projectKey || !rawNumber) return null;
  const result = await getPool().query<AccessRow>(
    `SELECT p.organization_id, m.organization_role, p.id AS project_id,
            p.project_key, pm.role AS project_role
       FROM issues i
       JOIN projects p ON p.id = i.project_id
       JOIN memberships m ON m.organization_id = p.organization_id AND m.user_id = $1
       LEFT JOIN effective_project_members pm ON pm.project_id = p.id AND pm.user_id = $1
      WHERE p.project_key = $2 AND i.number = $3 AND i.deleted_at IS NOT NULL
      LIMIT 1`,
    [userId, projectKey, rawNumber],
  );
  return result.rows[0] ? toAccess(result.rows[0]) : null;
}

const defaultStatuses = [
  {
    key: "backlog",
    name: "Backlog",
    category: "TODO",
    color: "#64748b",
    position: 0,
  },
  {
    key: "selected",
    name: "Selected",
    category: "TODO",
    color: "#3b82f6",
    position: 1,
  },
  {
    key: "inProgress",
    name: "In Progress",
    category: "IN_PROGRESS",
    color: "#f59e0b",
    position: 2,
  },
  {
    key: "review",
    name: "Review",
    category: "IN_PROGRESS",
    color: "#8b5cf6",
    position: 3,
  },
  {
    key: "done",
    name: "Done",
    category: "DONE",
    color: "#10b981",
    position: 4,
  },
] as const;

export async function createProject(
  identity: UserIdentity,
  input: { key: string; name: string; template?: ProjectTemplate },
  requestCorrelationId: string = randomUUID(),
  idempotency?: IdempotencyRequest,
): Promise<ProjectSummary> {
  return inTransaction(async (client) => {
    const operation = "project.create";
    if (idempotency) {
      const replay = await claimIdempotency<ProjectSummary>(
        client,
        identity,
        operation,
        idempotency,
      );
      if (replay) return replay;
    }

    const projectId = randomUUID();
    const workflowId = randomUUID();
    const boardId = randomUUID();
    const template = input.template ?? "FIVE_STATUS";
    await client.query(
      `INSERT INTO projects (id, organization_id, project_key, name)
       VALUES ($1, $2, $3, $4)`,
      [projectId, identity.organizationId, input.key, input.name],
    );
    await client.query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'ADMIN')`,
      [identity.organizationId, projectId, identity.id],
    );

    for (const name of ["Epic", "Story", "Task", "Bug", "Subtask"]) {
      await client.query(
        `INSERT INTO issue_types (id, organization_id, project_id, name, hierarchy_level)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          randomUUID(),
          identity.organizationId,
          projectId,
          name,
          name === "Epic" ? 1 : name === "Subtask" ? -1 : 0,
        ],
      );
    }

    await client.query(
      `INSERT INTO workflows (id, organization_id, project_id, name)
       VALUES ($1, $2, $3, 'Default workflow')`,
      [workflowId, identity.organizationId, projectId],
    );

    const statusIds = new Map<string, string>();
    const configuredStatuses =
      template === "SIMPLE"
        ? defaultStatuses.filter((status) =>
            ["backlog", "inProgress", "done"].includes(status.key),
          )
        : [...defaultStatuses];
    for (const [position, status] of configuredStatuses.entries()) {
      const id = randomUUID();
      statusIds.set(status.key, id);
      await client.query(
        `INSERT INTO statuses (id, organization_id, workflow_id, name, category, color, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          identity.organizationId,
          workflowId,
          status.name,
          status.category,
          status.color,
          position,
        ],
      );
    }

    const transitions =
      template === "SIMPLE"
        ? ([
            ["backlog", "inProgress"],
            ["inProgress", "backlog"],
            ["inProgress", "done"],
            ["done", "inProgress"],
          ] as const)
        : ([
            ["backlog", "selected"],
            ["backlog", "inProgress"],
            ["selected", "backlog"],
            ["selected", "inProgress"],
            ["inProgress", "selected"],
            ["inProgress", "review"],
            ["review", "inProgress"],
            ["review", "done"],
            ["done", "review"],
          ] as const);
    for (const [from, to] of transitions) {
      await client.query(
        `INSERT INTO transitions
          (id, organization_id, workflow_id, from_status_id, to_status_id, name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          identity.organizationId,
          workflowId,
          statusIds.get(from),
          statusIds.get(to),
          `Move to ${to}`,
        ],
      );
    }

    await client.query(
      `INSERT INTO boards (id, organization_id, project_id, name)
       VALUES ($1, $2, $3, 'Kanban board')`,
      [boardId, identity.organizationId, projectId],
    );
    const columnDefinitions =
      template === "SIMPLE"
        ? [
            { name: "To Do", statuses: ["backlog"] },
            { name: "In Progress", statuses: ["inProgress"] },
            { name: "Done", statuses: ["done"] },
          ]
        : [
            { name: "To Do", statuses: ["backlog", "selected"] },
            { name: "In Progress", statuses: ["inProgress", "review"] },
            { name: "Done", statuses: ["done"] },
          ];
    for (const [position, column] of columnDefinitions.entries()) {
      const columnId = randomUUID();
      await client.query(
        `INSERT INTO board_columns (id, organization_id, board_id, name, position)
         VALUES ($1, $2, $3, $4, $5)`,
        [columnId, identity.organizationId, boardId, column.name, position],
      );
      for (const statusKey of column.statuses) {
        await client.query(
          `INSERT INTO column_statuses (organization_id, board_column_id, status_id)
           VALUES ($1, $2, $3)`,
          [identity.organizationId, columnId, statusIds.get(statusKey)],
        );
      }
    }

    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, 'project.created', 'project', $4, $5, $6)`,
      [
        randomUUID(),
        identity.organizationId,
        identity.id,
        projectId,
        JSON.stringify({ template }),
        requestCorrelationId,
      ],
    );
    const project = {
      id: projectId,
      key: input.key,
      name: input.name,
      boardId,
    };
    if (idempotency) {
      await completeIdempotency(
        client,
        identity,
        operation,
        idempotency,
        project,
      );
    }
    return project;
  });
}

interface ResolvedIssueType {
  id: string;
  hierarchyLevel: IssueHierarchyLevel;
}

interface ResolvedParentIssue {
  id: string;
  key: string;
}

interface NormalizedLabel {
  displayName: string;
  normalizedName: string;
}

async function resolveIssueType(
  client: Pick<PoolClient, "query">,
  access: ProjectAccess,
  issueType: IssueType,
): Promise<ResolvedIssueType> {
  const result = await client.query<{
    id: string;
    hierarchy_level: IssueHierarchyLevel;
  }>(
    `SELECT id, hierarchy_level
       FROM issue_types
      WHERE organization_id = $1 AND project_id = $2 AND upper(name) = $3`,
    [access.organizationId, access.projectId, issueType],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DomainError(
      "PROJECT_CONFIGURATION",
      "The selected issue type is not configured for this project",
      500,
    );
  }
  return { id: row.id, hierarchyLevel: row.hierarchy_level };
}

async function assertAssignableUser(
  client: Pick<PoolClient, "query">,
  access: ProjectAccess,
  assigneeId: string | null,
): Promise<void> {
  if (!assigneeId) return;
  const assignee = await client.query<{ id: string }>(
    `SELECT u.id
       FROM effective_project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.organization_id = $1 AND pm.project_id = $2
        AND pm.user_id = $3 AND u.organization_id = $1
        AND pm.role IN ('ADMIN', 'MEMBER')
        AND u.state = 'ACTIVE'`,
    [access.organizationId, access.projectId, assigneeId],
  );
  if (!assignee.rows[0]) {
    throw new DomainError(
      "INVALID_ASSIGNEE",
      "Assignee must be an active project administrator or member",
      422,
    );
  }
}

async function resolveParentIssue(
  client: PoolClient,
  access: ProjectAccess,
  parentIssueKey: string | null,
  childLevel: IssueHierarchyLevel,
  currentIssueId?: string,
): Promise<ResolvedParentIssue | null> {
  if (!parentIssueKey) {
    assertIssueParent(childLevel, null);
    return null;
  }

  const [parentProjectKey, parentNumber] = splitIssueKey(parentIssueKey);
  if (parentProjectKey !== access.projectKey || !parentNumber) {
    throw new DomainError(
      "INVALID_PARENT",
      "Parent must be an active issue in the same project",
      422,
    );
  }
  const result = await client.query<{
    id: string;
    issue_key: string;
    hierarchy_level: IssueHierarchyLevel;
  }>(
    `SELECT i.id, p.project_key || '-' || i.number AS issue_key,
            it.hierarchy_level
       FROM issues i
       JOIN projects p ON p.id = i.project_id
       JOIN issue_types it ON it.id = i.issue_type_id
      WHERE i.organization_id = $1 AND i.project_id = $2
        AND p.project_key = $3 AND i.number = $4 AND i.deleted_at IS NULL
      FOR SHARE OF i`,
    [access.organizationId, access.projectId, parentProjectKey, parentNumber],
  );
  const parent = result.rows[0];
  if (!parent) {
    throw new DomainError(
      "INVALID_PARENT",
      "Parent must be an active issue in the same project",
      422,
    );
  }
  if (parent.id === currentIssueId) {
    throw new DomainError("ISSUE_CYCLE", "An issue cannot parent itself", 422);
  }
  assertIssueParent(childLevel, parent.hierarchy_level);
  return { id: parent.id, key: parent.issue_key };
}

async function assertExistingChildrenCompatible(
  client: PoolClient,
  access: ProjectAccess,
  issueId: string,
  hierarchyLevel: IssueHierarchyLevel,
): Promise<void> {
  const children = await client.query<{
    hierarchy_level: IssueHierarchyLevel;
  }>(
    `SELECT it.hierarchy_level
       FROM issues i
       JOIN issue_types it ON it.id = i.issue_type_id
      WHERE i.organization_id = $1 AND i.project_id = $2
        AND i.parent_id = $3 AND i.deleted_at IS NULL
      FOR SHARE OF i`,
    [access.organizationId, access.projectId, issueId],
  );
  assertChildrenCompatible(
    hierarchyLevel,
    children.rows.map((child) => child.hierarchy_level),
  );
}

function normalizeLabels(labels: string[]): NormalizedLabel[] {
  const normalized = new Map<string, NormalizedLabel>();
  for (const label of labels) {
    const displayName = label.trim().replace(/\s+/g, " ");
    const normalizedName = displayName.toLocaleLowerCase();
    if (!normalized.has(normalizedName)) {
      normalized.set(normalizedName, { displayName, normalizedName });
    }
  }
  return [...normalized.values()].sort((left, right) =>
    left.normalizedName.localeCompare(right.normalizedName),
  );
}

async function getIssueLabels(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  issueId: string,
): Promise<string[]> {
  const result = await client.query<{ display_name: string }>(
    `SELECT l.display_name
       FROM issue_labels il
       JOIN labels l ON l.id = il.label_id AND l.organization_id = il.organization_id
      WHERE il.organization_id = $1 AND il.issue_id = $2
      ORDER BY l.normalized_name`,
    [organizationId, issueId],
  );
  return result.rows.map((row) => row.display_name);
}

async function replaceIssueLabels(
  client: PoolClient,
  organizationId: string,
  issueId: string,
  labels: NormalizedLabel[],
): Promise<void> {
  await client.query(
    `DELETE FROM issue_labels WHERE organization_id = $1 AND issue_id = $2`,
    [organizationId, issueId],
  );
  for (const label of labels) {
    const saved = await client.query<{ id: string }>(
      `INSERT INTO labels (id, organization_id, normalized_name, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, normalized_name)
       DO UPDATE SET normalized_name = EXCLUDED.normalized_name
       RETURNING id`,
      [randomUUID(), organizationId, label.normalizedName, label.displayName],
    );
    await client.query(
      `INSERT INTO issue_labels (organization_id, issue_id, label_id)
       VALUES ($1, $2, $3)`,
      [organizationId, issueId, saved.rows[0]!.id],
    );
  }
}

export async function createIssue(
  identity: UserIdentity,
  access: ProjectAccess,
  input: {
    summary: string;
    description: string;
    priority: Priority;
    issueType: IssueType;
    assigneeId?: string | null;
    labels?: string[];
    parentIssueKey?: string | null;
    estimatePoints?: number | null;
    dueDate?: string | null;
  },
  requestCorrelationId: string = randomUUID(),
  idempotency?: IdempotencyRequest,
): Promise<IssueView> {
  return inTransaction(async (client) => {
    const operation = `issue.create:${access.projectId}`;
    if (idempotency) {
      const replay = await claimIdempotency<IssueView>(
        client,
        identity,
        operation,
        idempotency,
      );
      if (replay) return { ...replay, rank: String(replay.rank) };
    }

    await lockProjectOrdering(client, access.projectId);

    const issueId = randomUUID();
    const project = await client.query<{ sequence_counter: number }>(
      `UPDATE projects SET sequence_counter = sequence_counter + 1
        WHERE id = $1 AND organization_id = $2
        RETURNING sequence_counter`,
      [access.projectId, access.organizationId],
    );
    const number = project.rows[0]?.sequence_counter;
    if (!number)
      throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);

    const issueType = await resolveIssueType(client, access, input.issueType);
    const assigneeId = input.assigneeId ?? null;
    await assertAssignableUser(client, access, assigneeId);
    const parent = await resolveParentIssue(
      client,
      access,
      input.parentIssueKey ?? null,
      issueType.hierarchyLevel,
    );
    const labels = normalizeLabels(input.labels ?? []);

    const status = await client.query<{
      status_id: string;
      status_category: StatusCategory;
    }>(
      `SELECT s.id AS status_id, s.category AS status_category
         FROM statuses s
         JOIN workflows w ON w.id = s.workflow_id
         JOIN column_statuses cs ON cs.status_id = s.id
         JOIN board_columns bc ON bc.id = cs.board_column_id
         JOIN boards b ON b.id = bc.board_id AND b.project_id = w.project_id
        WHERE w.project_id = $1 AND w.organization_id = $2
          AND w.active
        ORDER BY bc.position, s.position, s.id
        LIMIT 1`,
      [access.projectId, access.organizationId],
    );
    const statusId = status.rows[0]?.status_id;
    const initialStatusCategory = status.rows[0]?.status_category;
    if (!statusId)
      throw new DomainError(
        "PROJECT_CONFIGURATION",
        "Project workflow is incomplete",
        500,
      );

    const destinationColumnId = await projectBoardColumnForStatus(
      client,
      access,
      statusId,
    );
    const columnIssues = await lockColumnIssues(
      client,
      access,
      destinationColumnId,
    );
    const rank = await allocateColumnRank(
      client,
      access,
      destinationColumnId,
      issueId,
      columnIssues.at(-1)?.id ?? null,
      null,
      columnIssues,
    );
    await client.query(
      `INSERT INTO issues
        (id, organization_id, project_id, number, issue_type_id, status_id,
        summary, description, priority, reporter_id, assignee_id, parent_id, rank,
        estimate_points, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15)`,
      [
        issueId,
        access.organizationId,
        access.projectId,
        number,
        issueType.id,
        statusId,
        input.summary,
        input.description,
        input.priority,
        identity.id,
        assigneeId,
        parent?.id ?? null,
        rank,
        input.estimatePoints ?? null,
        input.dueDate ?? null,
      ],
    );
    await replaceIssueLabels(client, access.organizationId, issueId, labels);
    await client.query(
      `INSERT INTO issue_events
        (id, organization_id, issue_id, actor_id, event_type, payload_json, correlation_id)
       VALUES ($1, $2, $3, $4, 'CREATED', $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        issueId,
        identity.id,
        JSON.stringify({
          summary: input.summary,
          statusId,
          initialStatusCategory,
          issueType: input.issueType,
          assigneeId,
          parentIssueKey: parent?.key ?? null,
          labels: labels.map((label) => label.displayName),
          estimatePoints: input.estimatePoints ?? null,
          dueDate: input.dueDate ?? null,
        }),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'issue.created', $3, $4)`,
      [
        randomUUID(),
        access.organizationId,
        issueId,
        JSON.stringify({
          issueId,
          projectId: access.projectId,
          correlationId: requestCorrelationId,
        }),
      ],
    );
    const issue = await getIssueById(issueId, access.organizationId, client);
    if (!issue) {
      throw new DomainError(
        "ISSUE_NOT_FOUND",
        "Issue not found after creation",
        500,
      );
    }
    if (idempotency) {
      await completeIdempotency(
        client,
        identity,
        operation,
        idempotency,
        issue,
      );
    }
    return issue;
  });
}

async function issueRows(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  whereSql: string,
  values: unknown[],
  suffixSql = "ORDER BY i.rank, i.id",
): Promise<IssueRow[]> {
  const result = await client.query<IssueRow>(
    `SELECT i.id, i.number AS issue_number,
            p.project_key || '-' || i.number AS issue_key, i.summary,
            i.description, i.priority, upper(it.name)::text AS issue_type, i.status_id,
            i.estimate_points, i.due_date::text,
            i.rank::text, i.version, reporter.id AS reporter_id,
            reporter.display_name AS reporter_name, assignee.id AS assignee_id,
            assignee.display_name AS assignee_name,
            ARRAY(
              SELECT l.display_name
                FROM issue_labels il
                JOIN labels l
                  ON l.id = il.label_id AND l.organization_id = il.organization_id
               WHERE il.organization_id = i.organization_id AND il.issue_id = i.id
               ORDER BY l.normalized_name
            ) AS labels,
            parent.id AS parent_id,
            CASE WHEN parent.id IS NULL THEN NULL
                 ELSE p.project_key || '-' || parent.number END AS parent_issue_key,
            parent.summary AS parent_summary,
            upper(parent_type.name)::text AS parent_issue_type,
            CASE
              WHEN upper(it.name) = 'EPIC' THEN i.id
              WHEN upper(parent_type.name) = 'EPIC' THEN parent.id
              WHEN upper(grandparent_type.name) = 'EPIC' THEN grandparent.id
              ELSE NULL
            END AS epic_id,
            CASE
              WHEN upper(it.name) = 'EPIC' THEN p.project_key || '-' || i.number
              WHEN upper(parent_type.name) = 'EPIC' THEN p.project_key || '-' || parent.number
              WHEN upper(grandparent_type.name) = 'EPIC' THEN p.project_key || '-' || grandparent.number
              ELSE NULL
            END AS epic_issue_key,
            CASE
              WHEN upper(it.name) = 'EPIC' THEN i.summary
              WHEN upper(parent_type.name) = 'EPIC' THEN parent.summary
              WHEN upper(grandparent_type.name) = 'EPIC' THEN grandparent.summary
              ELSE NULL
            END AS epic_summary,
            i.updated_at
       FROM issues i
       JOIN projects p ON p.id = i.project_id
       JOIN issue_types it ON it.id = i.issue_type_id
       JOIN users reporter ON reporter.id = i.reporter_id
       LEFT JOIN users assignee ON assignee.id = i.assignee_id
       LEFT JOIN issues parent
         ON parent.id = i.parent_id
        AND parent.organization_id = i.organization_id
        AND parent.project_id = i.project_id
        AND parent.deleted_at IS NULL
       LEFT JOIN issue_types parent_type ON parent_type.id = parent.issue_type_id
       LEFT JOIN issues grandparent
         ON grandparent.id = parent.parent_id
        AND grandparent.organization_id = i.organization_id
        AND grandparent.project_id = i.project_id
        AND grandparent.deleted_at IS NULL
       LEFT JOIN issue_types grandparent_type
         ON grandparent_type.id = grandparent.issue_type_id
      WHERE i.organization_id = $1 AND i.deleted_at IS NULL AND ${whereSql}
      ${suffixSql}`,
    [organizationId, ...values],
  );
  return result.rows;
}

async function transitionsForWorkflow(
  client: Pick<PoolClient, "query">,
  projectId: string,
): Promise<TransitionView[]> {
  const result = await client.query<{
    id: string;
    name: string;
    from_status_id: string;
    to_status_id: string;
  }>(
    `SELECT t.id, t.name, t.from_status_id, t.to_status_id
       FROM transitions t
       JOIN workflows w ON w.id = t.workflow_id
      WHERE w.project_id = $1 AND w.active`,
    [projectId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    fromStatusId: row.from_status_id,
    toStatusId: row.to_status_id,
  }));
}

function toIssue(row: IssueRow, transitions: TransitionView[]): IssueView {
  return {
    id: row.id,
    key: row.issue_key,
    summary: row.summary,
    description: row.description ?? "",
    priority: row.priority,
    issueType: row.issue_type,
    statusId: row.status_id,
    rank: row.rank,
    version: row.version,
    reporter: { id: row.reporter_id, displayName: row.reporter_name },
    assignee:
      row.assignee_id && row.assignee_name
        ? { id: row.assignee_id, displayName: row.assignee_name }
        : null,
    labels: row.labels,
    estimatePoints: row.estimate_points,
    dueDate: row.due_date,
    parent:
      row.parent_id &&
      row.parent_issue_key &&
      row.parent_summary &&
      row.parent_issue_type
        ? {
            id: row.parent_id,
            key: row.parent_issue_key,
            summary: row.parent_summary,
            issueType: row.parent_issue_type,
          }
        : null,
    epic:
      row.epic_id && row.epic_issue_key && row.epic_summary
        ? {
            id: row.epic_id,
            key: row.epic_issue_key,
            summary: row.epic_summary,
          }
        : null,
    updatedAt: row.updated_at.toISOString(),
    allowedTransitions: transitions.filter(
      (item) => item.fromStatusId === row.status_id,
    ),
  };
}

export async function listIssuesPage(
  access: ProjectAccess,
  options: PageOptions,
): Promise<Page<IssueView>> {
  const cursorKind = `project-issues:${access.projectId}`;
  const cursorValues = options.cursor
    ? decodeCursor(options.cursor, cursorKind)
    : null;
  if (
    cursorValues &&
    (cursorValues.length !== 2 ||
      typeof cursorValues[0] !== "number" ||
      !Number.isInteger(cursorValues[0]) ||
      cursorValues[0] < 1 ||
      typeof cursorValues[1] !== "string")
  ) {
    throw new DomainError(
      "INVALID_CURSOR",
      "The pagination cursor is invalid or expired",
      400,
    );
  }

  const limit = Math.min(Math.max(Math.trunc(options.limit), 1), 100);
  const values: unknown[] = [access.projectId];
  let whereSql = "i.project_id = $2";
  if (cursorValues) {
    values.push(cursorValues[0], cursorValues[1]);
    whereSql += " AND (i.number, i.id) > ($3, $4)";
  }
  values.push(limit + 1);
  const rows = await issueRows(
    getPool(),
    access.organizationId,
    whereSql,
    values,
    `ORDER BY i.number, i.id LIMIT $${values.length + 1}`,
  );
  const hasNextPage = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const transitions = await transitionsForWorkflow(getPool(), access.projectId);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) => toIssue(row, transitions)),
    nextCursor:
      hasNextPage && last
        ? encodeCursor(cursorKind, [last.issue_number, last.id])
        : null,
  };
}

async function getIssueById(
  id: string,
  organizationId: string,
  client: Pick<PoolClient, "query"> = getPool(),
): Promise<IssueView | null> {
  const rows = await issueRows(client, organizationId, "i.id = $2", [id]);
  const row = rows[0];
  if (!row) return null;
  const project = await client.query<{ project_id: string }>(
    "SELECT project_id FROM issues WHERE id = $1 AND organization_id = $2",
    [id, organizationId],
  );
  const transitions = await transitionsForWorkflow(
    client,
    project.rows[0]!.project_id,
  );
  return toIssue(row, transitions);
}

async function loadBoardColumns(
  client: Pick<PoolClient, "query">,
  boardId: string,
): Promise<BoardColumnView[]> {
  const result = await client.query<{
    id: string;
    name: string;
    position: number;
    wip_limit: number | null;
    version: number;
    status_id: string;
  }>(
    `SELECT bc.id, bc.name, bc.position, bc.wip_limit, bc.version, cs.status_id
       FROM board_columns bc
       JOIN column_statuses cs ON cs.board_column_id = bc.id
      WHERE bc.board_id = $1 ORDER BY bc.position, cs.status_id`,
    [boardId],
  );
  const columnsById = new Map<string, BoardColumnView>();
  for (const row of result.rows) {
    const column = columnsById.get(row.id) ?? {
      id: row.id,
      name: row.name,
      position: row.position,
      wipLimit: row.wip_limit,
      version: row.version,
      statusIds: [],
      issueCount: 0,
      tailIssueId: null,
      penultimateIssueId: null,
    };
    column.statusIds.push(row.status_id);
    columnsById.set(row.id, column);
  }
  const counts = await client.query<{
    board_column_id: string;
    issue_count: string;
    tail_issue_id: string | null;
    penultimate_issue_id: string | null;
  }>(
    `SELECT bc.id AS board_column_id, count(i.id)::text AS issue_count,
            (array_agg(i.id ORDER BY i.rank DESC, i.id DESC)
              FILTER (WHERE i.id IS NOT NULL))[1] AS tail_issue_id,
            (array_agg(i.id ORDER BY i.rank DESC, i.id DESC)
              FILTER (WHERE i.id IS NOT NULL))[2] AS penultimate_issue_id
       FROM board_columns bc
       LEFT JOIN column_statuses cs ON cs.board_column_id = bc.id
       LEFT JOIN issues i ON i.status_id = cs.status_id
        AND i.organization_id = bc.organization_id AND i.deleted_at IS NULL
      WHERE bc.board_id = $1
      GROUP BY bc.id`,
    [boardId],
  );
  for (const row of counts.rows) {
    const column = columnsById.get(row.board_column_id);
    if (!column) continue;
    column.issueCount = Number(row.issue_count);
    column.tailIssueId = row.tail_issue_id;
    column.penultimateIssueId = row.penultimate_issue_id;
  }
  return [...columnsById.values()].sort((a, b) => a.position - b.position);
}

function boardFilterKey(query: BoardIssuesQuery): string {
  return JSON.stringify({
    q: query.q ?? null,
    issueType: query.issueType ?? null,
    priority: query.priority ?? null,
    assignee: query.assignee ?? null,
    label: query.label ?? null,
    epicKey: query.epicKey ?? null,
  });
}

function boardIssueWhere(
  access: ProjectAccess,
  columnId: string,
  query: BoardIssuesQuery,
): { sql: string; values: unknown[] } {
  const values: unknown[] = [access.projectId, columnId];
  const parameter = (value: unknown) => {
    values.push(value);
    return `$${values.length + 1}`;
  };
  const predicates = [
    "i.project_id = $2",
    `EXISTS (
       SELECT 1 FROM column_statuses scoped_cs
        WHERE scoped_cs.board_column_id = $3
          AND scoped_cs.status_id = i.status_id
          AND scoped_cs.organization_id = i.organization_id
     )`,
  ];
  if (query.q) {
    const value = parameter(
      `%${query.q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
    );
    predicates.push(
      `(i.summary ILIKE ${value} ESCAPE '\\' OR
        coalesce(i.description, '') ILIKE ${value} ESCAPE '\\' OR
        ((SELECT project_key FROM projects WHERE id = i.project_id) || '-' || i.number::text)
          ILIKE ${value} ESCAPE '\\')`,
    );
  }
  if (query.issueType) {
    const value = parameter(query.issueType);
    predicates.push(
      `EXISTS (SELECT 1 FROM issue_types filter_type
        WHERE filter_type.id = i.issue_type_id
          AND upper(filter_type.name) = ${value})`,
    );
  }
  if (query.priority) {
    predicates.push(`i.priority = ${parameter(query.priority)}`);
  }
  if (query.assignee) {
    predicates.push(
      query.assignee === "unassigned"
        ? "i.assignee_id IS NULL"
        : `i.assignee_id = ${parameter(query.assignee)}`,
    );
  }
  if (query.label) {
    const value = parameter(query.label);
    predicates.push(
      `EXISTS (
         SELECT 1 FROM issue_labels filter_il
         JOIN labels filter_label ON filter_label.id = filter_il.label_id
          AND filter_label.organization_id = filter_il.organization_id
        WHERE filter_il.organization_id = i.organization_id
          AND filter_il.issue_id = i.id
          AND filter_label.normalized_name = lower(regexp_replace(trim(${value}), '\\s+', ' ', 'g'))
       )`,
    );
  }
  if (query.epicKey) {
    const [epicProjectKey, epicNumber] = splitIssueKey(query.epicKey);
    if (epicProjectKey !== access.projectKey) {
      predicates.push("false");
      return { sql: predicates.join(" AND "), values };
    }
    const value = parameter(epicNumber);
    predicates.push(
      `EXISTS (
         SELECT 1 FROM issues filter_epic
         JOIN issue_types filter_epic_type ON filter_epic_type.id = filter_epic.issue_type_id
        WHERE filter_epic.organization_id = i.organization_id
          AND filter_epic.project_id = i.project_id
          AND filter_epic.number = ${value}
          AND upper(filter_epic_type.name) = 'EPIC'
          AND filter_epic.deleted_at IS NULL
          AND (
            i.id = filter_epic.id OR i.parent_id = filter_epic.id OR
            EXISTS (SELECT 1 FROM issues filter_parent
              WHERE filter_parent.id = i.parent_id
                AND filter_parent.organization_id = i.organization_id
                AND filter_parent.project_id = i.project_id
                AND filter_parent.parent_id = filter_epic.id
                AND filter_parent.deleted_at IS NULL)
          )
       )`,
    );
  }
  return { sql: predicates.join(" AND "), values };
}

async function neighborsForIssues(
  client: Pick<PoolClient, "query">,
  access: ProjectAccess,
  columnId: string,
  issueIds: string[],
): Promise<BoardView["issueNeighbors"]> {
  if (issueIds.length === 0) return {};
  const result = await client.query<{
    id: string;
    previous_issue_id: string | null;
    next_issue_id: string | null;
  }>(
    `WITH ordered AS (
       SELECT i.id,
              lag(i.id) OVER (ORDER BY i.rank, i.id) AS previous_issue_id,
              lead(i.id) OVER (ORDER BY i.rank, i.id) AS next_issue_id
         FROM issues i
         JOIN column_statuses cs ON cs.status_id = i.status_id
          AND cs.organization_id = i.organization_id
        WHERE i.organization_id = $1 AND i.project_id = $2
          AND cs.board_column_id = $3 AND i.deleted_at IS NULL
     )
     SELECT id, previous_issue_id, next_issue_id FROM ordered
      WHERE id = ANY($4::uuid[])`,
    [access.organizationId, access.projectId, columnId, issueIds],
  );
  return Object.fromEntries(
    result.rows.map((row) => [
      row.id,
      {
        previousIssueId: row.previous_issue_id,
        nextIssueId: row.next_issue_id,
      },
    ]),
  );
}

export async function listBoardColumnIssuesPage(
  access: ProjectAccess,
  boardId: string,
  columnId: string,
  query: BoardIssuesQuery,
): Promise<BoardIssuePage> {
  const pool = getPool();
  const scopedColumn = await pool.query(
    `SELECT 1 FROM board_columns bc
      JOIN boards b ON b.id = bc.board_id
     WHERE bc.id = $1 AND b.id = $2 AND b.organization_id = $3
       AND b.project_id = $4`,
    [columnId, boardId, access.organizationId, access.projectId],
  );
  if (scopedColumn.rowCount !== 1) {
    throw new DomainError(
      "BOARD_COLUMN_NOT_FOUND",
      "Board column not found",
      404,
    );
  }
  const cursorKind = `board-column:${access.projectId}:${columnId}:${boardFilterKey(query)}`;
  const cursorValues = query.cursor
    ? decodeCursor(query.cursor, cursorKind)
    : null;
  if (
    cursorValues &&
    (cursorValues.length !== 2 ||
      typeof cursorValues[0] !== "string" ||
      typeof cursorValues[1] !== "string")
  ) {
    throw new DomainError(
      "INVALID_CURSOR",
      "The pagination cursor is invalid or expired",
      400,
    );
  }
  const filtered = boardIssueWhere(access, columnId, query);
  const countResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM issues i
      WHERE i.organization_id = $1 AND i.deleted_at IS NULL
        AND ${filtered.sql}`,
    [access.organizationId, ...filtered.values],
  );
  const values = [...filtered.values];
  let whereSql = filtered.sql;
  if (cursorValues) {
    values.push(cursorValues[0], cursorValues[1]);
    whereSql += ` AND (i.rank, i.id) > ($${values.length}, $${values.length + 1})`;
  }
  values.push(query.limit + 1);
  const rows = await issueRows(
    pool,
    access.organizationId,
    whereSql,
    values,
    `ORDER BY i.rank, i.id LIMIT $${values.length + 1}`,
  );
  const hasNextPage = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  const transitions = await transitionsForWorkflow(pool, access.projectId);
  const last = pageRows.at(-1);
  return {
    columnId,
    items: pageRows.map((row) => toIssue(row, transitions)),
    total: Number(countResult.rows[0]?.count ?? "0"),
    nextCursor:
      hasNextPage && last
        ? encodeCursor(cursorKind, [last.rank, last.id])
        : null,
    issueNeighbors: await neighborsForIssues(
      pool,
      access,
      columnId,
      pageRows.map((row) => row.id),
    ),
  };
}

type BoardBase = Omit<BoardView, "issues" | "issueNeighbors" | "columnPages">;

async function loadBoardBase(
  boardId: string,
  access: ProjectAccess,
): Promise<BoardBase | null> {
  const pool = getPool();
  const boardResult = await pool.query<{
    id: string;
    name: string;
    project_id: string;
    project_key: string;
    project_name: string;
  }>(
    `SELECT b.id, b.name, p.id AS project_id, p.project_key, p.name AS project_name
       FROM boards b JOIN projects p ON p.id = b.project_id
      WHERE b.id = $1 AND b.organization_id = $2`,
    [boardId, access.organizationId],
  );
  const board = boardResult.rows[0];
  if (!board) return null;

  const columns = await loadBoardColumns(pool, boardId);

  const statusResult = await pool.query<{
    id: string;
    name: string;
    category: StatusView["category"];
    color: string;
    position: number;
  }>(
    `SELECT s.id, s.name, s.category, s.color, s.position
       FROM statuses s JOIN workflows w ON w.id = s.workflow_id
      WHERE w.project_id = $1 AND w.active ORDER BY s.position`,
    [board.project_id],
  );
  const memberResult = await pool.query<{
    id: string;
    display_name: string;
  }>(
    `SELECT u.id, u.display_name
       FROM effective_project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1 AND pm.organization_id = $2
        AND pm.role IN ('ADMIN', 'MEMBER')
        AND u.organization_id = $2 AND u.state = 'ACTIVE'
      ORDER BY u.display_name, u.id`,
    [board.project_id, access.organizationId],
  );
  const epicResult = await pool.query<{
    id: string;
    issue_key: string;
    summary: string;
  }>(
    `SELECT i.id, p.project_key || '-' || i.number AS issue_key, i.summary
       FROM issues i
       JOIN projects p ON p.id = i.project_id
       JOIN issue_types it ON it.id = i.issue_type_id
      WHERE i.organization_id = $1 AND i.project_id = $2
        AND i.deleted_at IS NULL AND upper(it.name) = 'EPIC'
      ORDER BY i.number, i.id`,
    [access.organizationId, board.project_id],
  );
  return {
    id: board.id,
    name: board.name,
    project: {
      id: board.project_id,
      key: board.project_key,
      name: board.project_name,
    },
    columns,
    statuses: statusResult.rows,
    assignees: memberResult.rows.map((row): AssignableUserView => ({
      id: row.id,
      displayName: row.display_name,
    })),
    epics: epicResult.rows.map((row) => ({
      id: row.id,
      key: row.issue_key,
      summary: row.summary,
    })),
  };
}

export async function getBoard(
  boardId: string,
  access: ProjectAccess,
): Promise<BoardView | null> {
  const base = await loadBoardBase(boardId, access);
  if (!base) return null;
  const pool = getPool();
  const rows = await issueRows(
    pool,
    access.organizationId,
    "i.project_id = $2",
    [access.projectId],
  );
  const transitions = await transitionsForWorkflow(pool, access.projectId);
  const issues = rows.map((row) => toIssue(row, transitions));
  const neighbors = Object.assign(
    {},
    ...(await Promise.all(
      base.columns.map((column) =>
        neighborsForIssues(
          pool,
          access,
          column.id,
          issues
            .filter((issue) => column.statusIds.includes(issue.statusId))
            .map((issue) => issue.id),
        ),
      ),
    )),
  ) as BoardView["issueNeighbors"];
  return {
    ...base,
    issues,
    issueNeighbors: neighbors,
    columnPages: base.columns.map((column) => ({
      columnId: column.id,
      total: column.issueCount,
      nextCursor: null,
    })),
  };
}

export async function getBoardPage(
  boardId: string,
  access: ProjectAccess,
  query: BoardIssuesQuery,
): Promise<BoardView | null> {
  const base = await loadBoardBase(boardId, access);
  if (!base) return null;
  const firstPageQuery = { ...query };
  delete firstPageQuery.cursor;
  const pages = await Promise.all(
    base.columns.map((column) =>
      listBoardColumnIssuesPage(access, boardId, column.id, firstPageQuery),
    ),
  );
  return {
    ...base,
    issues: pages.flatMap((page) => page.items),
    issueNeighbors: Object.assign(
      {},
      ...pages.map((page) => page.issueNeighbors),
    ) as BoardView["issueNeighbors"],
    columnPages: pages.map((page) => ({
      columnId: page.columnId,
      total: page.total,
      nextCursor: page.nextCursor,
    })),
  };
}

export async function getBoardSettings(
  access: ProjectAccess,
): Promise<BoardSettingsView> {
  const result = await getPool().query<{
    id: string;
    name: string;
    project_name: string;
  }>(
    `SELECT b.id, b.name, p.name AS project_name
       FROM boards b
       JOIN projects p ON p.id = b.project_id
      WHERE b.organization_id = $1 AND b.project_id = $2
        AND p.archived_at IS NULL
      ORDER BY b.id
      LIMIT 1`,
    [access.organizationId, access.projectId],
  );
  const board = result.rows[0];
  if (!board) {
    throw new DomainError("BOARD_NOT_FOUND", "Board not found", 404);
  }
  return {
    project: {
      id: access.projectId,
      key: access.projectKey,
      name: board.project_name,
      boardId: board.id,
    },
    board: { id: board.id, name: board.name },
    columns: await loadBoardColumns(getPool(), board.id),
  };
}

export async function getWorkflowSettings(
  access: ProjectAccess,
  client: Pick<PoolClient, "query"> = getPool(),
): Promise<WorkflowSettingsView> {
  const workflowResult = await client.query<{
    id: string;
    name: string;
    version: number;
    board_id: string;
    board_name: string;
    project_name: string;
  }>(
    `SELECT w.id, w.name, w.version, b.id AS board_id,
            b.name AS board_name, p.name AS project_name
       FROM workflows w
       JOIN projects p ON p.id = w.project_id
       JOIN boards b ON b.project_id = p.id AND b.organization_id = p.organization_id
      WHERE w.organization_id = $1 AND w.project_id = $2 AND w.active
        AND p.archived_at IS NULL
      ORDER BY b.id
      LIMIT 1`,
    [access.organizationId, access.projectId],
  );
  const workflow = workflowResult.rows[0];
  if (!workflow) {
    throw new DomainError(
      "WORKFLOW_NOT_FOUND",
      "Active workflow not found",
      404,
    );
  }
  const [columns, statuses, transitions] = await Promise.all([
    client.query<{
      id: string;
      name: string;
      position: number;
      version: number;
    }>(
      `SELECT id, name, position, version FROM board_columns
        WHERE organization_id = $1 AND board_id = $2
        ORDER BY position, id`,
      [access.organizationId, workflow.board_id],
    ),
    client.query<{
      id: string;
      name: string;
      category: StatusCategory;
      color: string;
      position: number;
      column_id: string;
      issue_count: string;
    }>(
      `SELECT s.id, s.name, s.category, s.color, s.position,
              cs.board_column_id AS column_id, count(i.id)::text AS issue_count
         FROM statuses s
         JOIN column_statuses cs
           ON cs.status_id = s.id AND cs.organization_id = s.organization_id
         JOIN board_columns bc ON bc.id = cs.board_column_id
         LEFT JOIN issues i
           ON i.status_id = s.id AND i.organization_id = s.organization_id
        WHERE s.organization_id = $1 AND s.workflow_id = $2
          AND bc.board_id = $3
        GROUP BY s.id, cs.board_column_id
        ORDER BY s.position, s.id`,
      [access.organizationId, workflow.id, workflow.board_id],
    ),
    client.query<{
      id: string;
      name: string;
      from_status_id: string;
      to_status_id: string;
    }>(
      `SELECT id, name, from_status_id, to_status_id
         FROM transitions
        WHERE organization_id = $1 AND workflow_id = $2
        ORDER BY from_status_id, to_status_id, id`,
      [access.organizationId, workflow.id],
    ),
  ]);
  return {
    project: {
      id: access.projectId,
      key: access.projectKey,
      name: workflow.project_name,
      boardId: workflow.board_id,
    },
    board: { id: workflow.board_id, name: workflow.board_name },
    workflow: {
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
    },
    columns: columns.rows,
    statuses: statuses.rows.map((status) => ({
      id: status.id,
      name: status.name,
      category: status.category,
      color: status.color,
      position: status.position,
      columnId: status.column_id,
      issueCount: Number(status.issue_count),
    })),
    transitions: transitions.rows.map((transition) => ({
      id: transition.id,
      name: transition.name,
      fromStatusId: transition.from_status_id,
      toStatusId: transition.to_status_id,
    })),
  };
}

export async function updateWorkflowConfiguration(
  identity: UserIdentity,
  access: ProjectAccess,
  input: UpdateWorkflowConfigurationInput,
  requestCorrelationId: string = randomUUID(),
): Promise<WorkflowSettingsView> {
  assertCapability(
    access.organizationRole,
    access.projectRole,
    "project:admin",
  );
  return inTransaction(async (client) => {
    const workflowResult = await client.query<{
      id: string;
      version: number;
      board_id: string;
    }>(
      `SELECT w.id, w.version, b.id AS board_id
         FROM workflows w
         JOIN boards b ON b.project_id = w.project_id
          AND b.organization_id = w.organization_id
        WHERE w.organization_id = $1 AND w.project_id = $2 AND w.active
        ORDER BY b.id
        LIMIT 1
        FOR UPDATE OF w`,
      [access.organizationId, access.projectId],
    );
    const workflow = workflowResult.rows[0];
    if (!workflow) {
      throw new DomainError(
        "WORKFLOW_NOT_FOUND",
        "Active workflow not found",
        404,
      );
    }
    if (workflow.version !== input.version) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "This workflow changed since it was loaded. Refresh and try again.",
        409,
      );
    }
    const columnResult = await client.query<{
      id: string;
      name: string;
    }>(
      `SELECT id, name FROM board_columns
        WHERE organization_id = $1 AND board_id = $2
        ORDER BY position, id
        FOR UPDATE`,
      [access.organizationId, workflow.board_id],
    );
    const columnIds = new Set(columnResult.rows.map((column) => column.id));
    if (columnIds.size === 0) {
      throw new DomainError(
        "BOARD_NOT_FOUND",
        "The workflow board has no columns",
        409,
      );
    }
    for (const status of input.statuses) {
      if (!columnIds.has(status.columnId)) {
        throw new DomainError(
          "INVALID_COLUMN_MAPPING",
          "Every status must map to a column on this board",
          422,
        );
      }
    }
    for (const columnId of columnIds) {
      if (!input.statuses.some((status) => status.columnId === columnId)) {
        throw new DomainError(
          "EMPTY_BOARD_COLUMN",
          "Every board column must keep at least one workflow status",
          422,
        );
      }
    }

    const currentResult = await client.query<{
      id: string;
      name: string;
      category: StatusCategory;
      issue_count: string;
    }>(
      `SELECT s.id, s.name, s.category,
              (SELECT count(*)::text FROM issues i
                WHERE i.status_id = s.id
                  AND i.organization_id = s.organization_id) AS issue_count
         FROM statuses s
        WHERE s.organization_id = $1 AND s.workflow_id = $2
        ORDER BY s.position, s.id
        FOR UPDATE OF s`,
      [access.organizationId, workflow.id],
    );
    const currentIds = new Set(currentResult.rows.map((status) => status.id));
    const desiredIds = new Set(input.statuses.map((status) => status.id));
    const newIds = input.statuses
      .map((status) => status.id)
      .filter((statusId) => !currentIds.has(statusId));
    if (newIds.length > 0) {
      const collisions = await client.query<{ id: string }>(
        `SELECT id FROM statuses WHERE id = ANY($1::uuid[]) LIMIT 1`,
        [newIds],
      );
      if (collisions.rows[0]) {
        throw new DomainError(
          "STATUS_ID_TAKEN",
          "A new status identifier is already in use",
          409,
        );
      }
    }
    const removed = currentResult.rows.filter(
      (status) => !desiredIds.has(status.id),
    );
    const migrationTargets = new Map(
      input.removedStatusMigrations.map((migration) => [
        migration.fromStatusId,
        migration.toStatusId,
      ]),
    );
    for (const migration of input.removedStatusMigrations) {
      if (
        !currentIds.has(migration.fromStatusId) ||
        desiredIds.has(migration.fromStatusId)
      ) {
        throw new DomainError(
          "INVALID_STATUS_MIGRATION",
          "Only removed statuses can declare a migration target",
          422,
        );
      }
    }
    for (const status of removed) {
      if (Number(status.issue_count) > 0 && !migrationTargets.has(status.id)) {
        throw new DomainError(
          "STATUS_IN_USE",
          `${status.name} is used by issues. Select a migration target before removing it.`,
          409,
        );
      }
    }

    await client.query(
      `DELETE FROM transitions
        WHERE organization_id = $1 AND workflow_id = $2`,
      [access.organizationId, workflow.id],
    );
    await client.query(
      `DELETE FROM column_statuses
        WHERE organization_id = $1
          AND status_id IN (
            SELECT id FROM statuses WHERE workflow_id = $2
          )`,
      [access.organizationId, workflow.id],
    );
    if (currentIds.size > 0) {
      await client.query(
        `UPDATE statuses
            SET name = '__workflow_update__' || id::text,
                position = position + 1000000
          WHERE organization_id = $1 AND workflow_id = $2`,
        [access.organizationId, workflow.id],
      );
    }
    for (const [position, status] of input.statuses.entries()) {
      if (currentIds.has(status.id)) {
        await client.query(
          `UPDATE statuses
              SET name = $1, category = $2, color = $3, position = $4
            WHERE id = $5 AND organization_id = $6 AND workflow_id = $7`,
          [
            status.name,
            status.category,
            status.color,
            position,
            status.id,
            access.organizationId,
            workflow.id,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO statuses
            (id, organization_id, workflow_id, name, category, color, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            status.id,
            access.organizationId,
            workflow.id,
            status.name,
            status.category,
            status.color,
            position,
          ],
        );
      }
    }

    for (const status of removed) {
      const targetId = migrationTargets.get(status.id);
      if (targetId) {
        const targetStatus = input.statuses.find(
          (item) => item.id === targetId,
        );
        const migrated = await client.query<{
          id: string;
          from_version: number;
          to_version: number;
        }>(
          `UPDATE issues
              SET status_id = $1, version = version + 1, updated_at = now()
            WHERE organization_id = $2 AND project_id = $3 AND status_id = $4
            RETURNING id, version - 1 AS from_version, version AS to_version`,
          [targetId, access.organizationId, access.projectId, status.id],
        );
        for (const issue of migrated.rows) {
          const payload = {
            reason: "WORKFLOW_STATUS_MIGRATION",
            fromStatusId: status.id,
            toStatusId: targetId,
            fromStatusCategory: status.category,
            toStatusCategory: targetStatus?.category,
            fromVersion: issue.from_version,
            toVersion: issue.to_version,
          };
          await client.query(
            `INSERT INTO issue_events
              (id, organization_id, issue_id, actor_id, event_type,
               payload_json, correlation_id)
             VALUES ($1, $2, $3, $4, 'TRANSITIONED', $5, $6)`,
            [
              randomUUID(),
              access.organizationId,
              issue.id,
              identity.id,
              JSON.stringify(payload),
              requestCorrelationId,
            ],
          );
          await client.query(
            `INSERT INTO audit_events
              (id, organization_id, actor_id, action, target_type, target_id,
               metadata, correlation_id)
             VALUES ($1, $2, $3, 'issue.workflow_migrated', 'issue', $4, $5, $6)`,
            [
              randomUUID(),
              access.organizationId,
              identity.id,
              issue.id,
              JSON.stringify(payload),
              requestCorrelationId,
            ],
          );
          await client.query(
            `INSERT INTO outbox_events
              (id, organization_id, topic, aggregate_id, payload)
             VALUES ($1, $2, 'issue.workflow_migrated', $3, $4)`,
            [
              randomUUID(),
              access.organizationId,
              issue.id,
              JSON.stringify({
                ...payload,
                correlationId: requestCorrelationId,
              }),
            ],
          );
        }
      }
      await client.query(
        `DELETE FROM statuses
          WHERE id = $1 AND organization_id = $2 AND workflow_id = $3`,
        [status.id, access.organizationId, workflow.id],
      );
    }

    for (const status of input.statuses) {
      await client.query(
        `INSERT INTO column_statuses
          (organization_id, board_column_id, status_id)
         VALUES ($1, $2, $3)`,
        [access.organizationId, status.columnId, status.id],
      );
    }
    const statusNames = new Map(
      input.statuses.map((status) => [status.id, status.name]),
    );
    for (const transition of input.transitions) {
      await client.query(
        `INSERT INTO transitions
          (id, organization_id, workflow_id, from_status_id, to_status_id, name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          access.organizationId,
          workflow.id,
          transition.fromStatusId,
          transition.toStatusId,
          `Move to ${statusNames.get(transition.toStatusId)}`,
        ],
      );
    }
    await client.query(
      `UPDATE workflows SET version = version + 1
        WHERE id = $1 AND organization_id = $2 AND version = $3`,
      [workflow.id, access.organizationId, input.version],
    );
    await client.query(
      `UPDATE board_columns SET version = version + 1
        WHERE organization_id = $1 AND board_id = $2`,
      [access.organizationId, workflow.board_id],
    );
    const metadata = {
      fromVersion: workflow.version,
      toVersion: workflow.version + 1,
      statusCount: input.statuses.length,
      transitionCount: input.transitions.length,
      removedStatusIds: removed.map((status) => status.id),
    };
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, 'workflow.updated', 'workflow', $4, $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        identity.id,
        workflow.id,
        JSON.stringify(metadata),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'workflow.updated', $3, $4)`,
      [
        randomUUID(),
        access.organizationId,
        workflow.id,
        JSON.stringify({ ...metadata, correlationId: requestCorrelationId }),
      ],
    );
    return getWorkflowSettings(access, client);
  });
}

export async function updateBoardColumnWipLimit(
  identity: UserIdentity,
  access: ProjectAccess,
  columnId: string,
  input: { wipLimit: number | null; version: number },
  requestCorrelationId: string = randomUUID(),
): Promise<BoardColumnView> {
  await inTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      wip_limit: number | null;
      version: number;
    }>(
      `SELECT bc.id, bc.wip_limit, bc.version
         FROM board_columns bc
         JOIN boards b ON b.id = bc.board_id
        WHERE bc.id = $1 AND b.organization_id = $2 AND b.project_id = $3
        FOR UPDATE OF bc`,
      [columnId, access.organizationId, access.projectId],
    );
    const column = result.rows[0];
    if (!column) {
      throw new DomainError(
        "BOARD_COLUMN_NOT_FOUND",
        "Board column not found",
        404,
      );
    }
    if (column.version !== input.version) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "This board column changed since it was loaded. Refresh and try again.",
        409,
      );
    }
    if (column.wip_limit === input.wipLimit) return;

    const updated = await client.query(
      `UPDATE board_columns
          SET wip_limit = $1, version = version + 1
        WHERE id = $2 AND version = $3`,
      [input.wipLimit, column.id, input.version],
    );
    if (updated.rowCount !== 1) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "This board column changed since it was loaded. Refresh and try again.",
        409,
      );
    }
    const payload = {
      boardColumnId: column.id,
      fromWipLimit: column.wip_limit,
      toWipLimit: input.wipLimit,
      fromVersion: column.version,
      toVersion: column.version + 1,
    };
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, metadata, correlation_id)
       VALUES ($1, $2, $3, 'board.column.wip_limit.updated', 'board_column', $4, $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        identity.id,
        column.id,
        JSON.stringify(payload),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'board.column.wip_limit.updated', $3, $4)`,
      [
        randomUUID(),
        access.organizationId,
        column.id,
        JSON.stringify({ ...payload, correlationId: requestCorrelationId }),
      ],
    );
  });

  const settings = await getBoardSettings(access);
  const updated = settings.columns.find((column) => column.id === columnId);
  if (!updated) {
    throw new DomainError(
      "BOARD_COLUMN_NOT_FOUND",
      "Board column not found after update",
      500,
    );
  }
  return updated;
}

export async function getIssueDetail(
  issueKey: string,
  access: ProjectAccess,
): Promise<IssueDetailView | null> {
  const [projectKey, number] = splitIssueKey(issueKey);
  if (!projectKey || !number) return null;
  const rows = await issueRows(
    getPool(),
    access.organizationId,
    "i.project_id = $2 AND p.project_key = $3 AND i.number = $4",
    [access.projectId, projectKey, number],
  );
  const row = rows[0];
  if (!row) return null;
  const transitions = await transitionsForWorkflow(getPool(), access.projectId);
  const eventResult = await getPool().query<{
    id: string;
    event_type: IssueEventView["eventType"];
    actor_name: string;
    payload_json: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT e.id, e.event_type, u.display_name AS actor_name,
            e.payload_json, e.created_at
       FROM issue_events e JOIN users u ON u.id = e.actor_id
      WHERE e.issue_id = $1 ORDER BY e.created_at, e.id`,
    [row.id],
  );
  return {
    ...toIssue(row, transitions),
    events: eventResult.rows.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      actorName: event.actor_name,
      payload: event.payload_json,
      createdAt: event.created_at.toISOString(),
    })),
  };
}

async function collaborationIssueId(
  client: Pick<PoolClient, "query">,
  access: ProjectAccess,
  issueKey: string,
  lock = false,
): Promise<{
  id: string;
  reporterId: string;
  assigneeId: string | null;
} | null> {
  const [projectKey, number] = splitIssueKey(issueKey);
  if (!projectKey || !number) return null;
  const result = await client.query<{
    id: string;
    reporter_id: string;
    assignee_id: string | null;
  }>(
    `SELECT i.id, i.reporter_id, i.assignee_id
       FROM issues i
       JOIN projects p ON p.id = i.project_id
      WHERE i.organization_id = $1 AND i.project_id = $2
        AND p.project_key = $3 AND i.number = $4 AND i.deleted_at IS NULL
      ${lock ? "FOR UPDATE OF i" : ""}`,
    [access.organizationId, access.projectId, projectKey, number],
  );
  const issue = result.rows[0];
  return issue
    ? {
        id: issue.id,
        reporterId: issue.reporter_id,
        assigneeId: issue.assignee_id,
      }
    : null;
}

export async function getIssueCollaboration(
  access: ProjectAccess,
  issueKey: string,
  viewerId: string,
): Promise<IssueCollaborationView> {
  const pool = getPool();
  const issue = await collaborationIssueId(pool, access, issueKey);
  if (!issue) {
    throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
  }
  const comments = await pool.query<{
    id: string;
    body: string;
    author_id: string;
    author_name: string;
    mentions: CommentView["mentions"];
    created_at: Date;
  }>(
    `SELECT c.id, c.body, author.id AS author_id,
            author.display_name AS author_name, c.created_at,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id', mentioned.id,
                  'displayName', mentioned.display_name,
                  'email', mentioned.email
                ) ORDER BY mentioned.display_name, mentioned.id
              ) FILTER (WHERE mentioned.id IS NOT NULL),
              '[]'::jsonb
            ) AS mentions
       FROM comments c
       JOIN users author ON author.id = c.author_id
       LEFT JOIN comment_mentions cm ON cm.comment_id = c.id
       LEFT JOIN users mentioned ON mentioned.id = cm.user_id
      WHERE c.organization_id = $1 AND c.issue_id = $2
      GROUP BY c.id, author.id
      ORDER BY c.created_at, c.id`,
    [access.organizationId, issue.id],
  );
  const watcher = await pool.query<{
    watcher_count: string;
    is_watching: boolean;
  }>(
    `SELECT count(*) FILTER (WHERE state = 'WATCHING')::text AS watcher_count,
            coalesce(bool_or(user_id = $3 AND state = 'WATCHING'), false) AS is_watching
       FROM issue_watchers
      WHERE organization_id = $1 AND issue_id = $2`,
    [access.organizationId, issue.id, viewerId],
  );
  return {
    comments: comments.rows.map((comment) => ({
      id: comment.id,
      body: comment.body,
      author: { id: comment.author_id, displayName: comment.author_name },
      mentions: comment.mentions,
      createdAt: comment.created_at.toISOString(),
    })),
    isWatching: watcher.rows[0]?.is_watching ?? false,
    watcherCount: Number(watcher.rows[0]?.watcher_count ?? 0),
  };
}

export async function createIssueComment(
  identity: UserIdentity,
  access: ProjectAccess,
  issueKey: string,
  body: string,
  requestCorrelationId: string = randomUUID(),
  idempotency?: IdempotencyRequest,
): Promise<IssueCollaborationView> {
  assertCapability(
    access.organizationRole,
    access.projectRole,
    "comment:create",
  );
  await inTransaction(async (client) => {
    const operation = `comment.create:${access.projectId}:${issueKey}`;
    if (idempotency) {
      const replay = await claimIdempotency<{ commentId: string }>(
        client,
        identity,
        operation,
        idempotency,
      );
      if (replay) return;
    }
    const issue = await collaborationIssueId(client, access, issueKey, true);
    if (!issue) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    const mentionEmails = parseMentionEmails(body);
    const mentioned = await client.query<{
      id: string;
      email: string;
      display_name: string;
    }>(
      `SELECT DISTINCT u.id, lower(u.email) AS email, u.display_name
         FROM users u
         JOIN memberships m
           ON m.organization_id = u.organization_id AND m.user_id = u.id
         LEFT JOIN effective_project_members pm
           ON pm.organization_id = u.organization_id
          AND pm.project_id = $2 AND pm.user_id = u.id
        WHERE u.organization_id = $1 AND u.state = 'ACTIVE'
          AND lower(u.email) = ANY($3::text[])
          AND (m.organization_role = 'ADMIN' OR pm.role IS NOT NULL)`,
      [access.organizationId, access.projectId, mentionEmails],
    );
    if (mentioned.rowCount !== mentionEmails.length) {
      throw new DomainError(
        "MENTION_NOT_AVAILABLE",
        "Every mentioned email must belong to an active project member",
        422,
      );
    }
    const commentId = randomUUID();
    await client.query(
      `INSERT INTO comments
        (id, organization_id, issue_id, author_id, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [commentId, access.organizationId, issue.id, identity.id, body],
    );
    for (const user of mentioned.rows) {
      await client.query(
        `INSERT INTO comment_mentions
          (organization_id, comment_id, user_id)
         VALUES ($1, $2, $3)`,
        [access.organizationId, commentId, user.id],
      );
    }
    const participants = new Set(
      [
        identity.id,
        issue.reporterId,
        issue.assigneeId,
        ...mentioned.rows.map((user) => user.id),
      ].filter((userId): userId is string => Boolean(userId)),
    );
    for (const userId of participants) {
      await client.query(
        `INSERT INTO issue_watchers
          (organization_id, issue_id, user_id, state, source)
         VALUES ($1, $2, $3, 'WATCHING', 'AUTO')
         ON CONFLICT (issue_id, user_id) DO NOTHING`,
        [access.organizationId, issue.id, userId],
      );
    }
    const version = await client.query<{ version: number }>(
      `UPDATE issues
          SET version = version + 1, updated_at = now()
        WHERE id = $1 AND organization_id = $2
        RETURNING version`,
      [issue.id, access.organizationId],
    );
    const payload = {
      commentId,
      mentionedUserIds: mentioned.rows.map((user) => user.id),
      toVersion: version.rows[0]!.version,
    };
    await client.query(
      `INSERT INTO issue_events
        (id, organization_id, issue_id, actor_id, event_type, payload_json, correlation_id)
       VALUES ($1, $2, $3, $4, 'COMMENTED', $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        issue.id,
        identity.id,
        JSON.stringify(payload),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, metadata, correlation_id)
       VALUES ($1, $2, $3, 'comment.created', 'issue', $4, $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        identity.id,
        issue.id,
        JSON.stringify(payload),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'comment.created', $3, $4)`,
      [
        randomUUID(),
        access.organizationId,
        commentId,
        JSON.stringify({
          ...payload,
          issueId: issue.id,
          actorId: identity.id,
          correlationId: requestCorrelationId,
        }),
      ],
    );
    for (const user of mentioned.rows) {
      if (user.id === identity.id) continue;
      await client.query(
        `INSERT INTO outbox_events
          (id, organization_id, topic, aggregate_id, payload)
         VALUES ($1, $2, 'notification.mention', $3, $4)`,
        [
          randomUUID(),
          access.organizationId,
          commentId,
          JSON.stringify({
            commentId,
            issueId: issue.id,
            actorId: identity.id,
            recipientUserId: user.id,
            correlationId: requestCorrelationId,
          }),
        ],
      );
    }
    const mentionedIds = mentioned.rows.map((user) => user.id);
    const watchers = await client.query<{ user_id: string }>(
      `SELECT user_id FROM issue_watchers
        WHERE organization_id = $1 AND issue_id = $2 AND state = 'WATCHING'
          AND user_id <> $3 AND NOT (user_id = ANY($4::uuid[]))
        ORDER BY user_id`,
      [access.organizationId, issue.id, identity.id, mentionedIds],
    );
    for (const watcher of watchers.rows) {
      await client.query(
        `INSERT INTO outbox_events
          (id, organization_id, topic, aggregate_id, payload)
         VALUES ($1, $2, 'notification.issue_commented', $3, $4)`,
        [
          randomUUID(),
          access.organizationId,
          commentId,
          JSON.stringify({
            commentId,
            issueId: issue.id,
            actorId: identity.id,
            recipientUserId: watcher.user_id,
            correlationId: requestCorrelationId,
          }),
        ],
      );
    }
    if (idempotency) {
      await completeIdempotency(client, identity, operation, idempotency, {
        commentId,
      });
    }
  });
  return getIssueCollaboration(access, issueKey, identity.id);
}

export async function setIssueWatching(
  identity: UserIdentity,
  access: ProjectAccess,
  issueKey: string,
  watching: boolean,
  requestCorrelationId: string = randomUUID(),
): Promise<IssueCollaborationView> {
  assertCapability(access.organizationRole, access.projectRole, "issue:watch");
  await inTransaction(async (client) => {
    const issue = await collaborationIssueId(client, access, issueKey, true);
    if (!issue) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    const current = await client.query<{ state: "WATCHING" | "MUTED" }>(
      `SELECT state FROM issue_watchers
        WHERE organization_id = $1 AND issue_id = $2 AND user_id = $3`,
      [access.organizationId, issue.id, identity.id],
    );
    const state = watching ? "WATCHING" : "MUTED";
    if (current.rows[0]?.state === state) return;
    await client.query(
      `INSERT INTO issue_watchers
        (organization_id, issue_id, user_id, state, source)
       VALUES ($1, $2, $3, $4, 'EXPLICIT')
       ON CONFLICT (issue_id, user_id) DO UPDATE
         SET state = EXCLUDED.state, source = 'EXPLICIT', updated_at = now()`,
      [access.organizationId, issue.id, identity.id, state],
    );
    const action = watching ? "issue.watched" : "issue.unwatched";
    const payload = { issueId: issue.id, userId: identity.id, watching };
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, metadata, correlation_id)
       VALUES ($1, $2, $3, $4, 'issue', $5, $6, $7)`,
      [
        randomUUID(),
        access.organizationId,
        identity.id,
        action,
        issue.id,
        JSON.stringify(payload),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        access.organizationId,
        action,
        issue.id,
        JSON.stringify({ ...payload, correlationId: requestCorrelationId }),
      ],
    );
  });
  return getIssueCollaboration(access, issueKey, identity.id);
}

export interface StoredAttachmentView extends AttachmentView {
  objectKey: string;
}

interface AttachmentRow extends QueryResultRow {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  scan_state: AttachmentScanState;
  uploader_id: string;
  uploader_name: string;
  created_at: Date;
}

function attachmentView(
  row: AttachmentRow,
  identity: UserIdentity,
  access: ProjectAccess,
): StoredAttachmentView {
  return {
    id: row.id,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    scanState: row.scan_state,
    uploader: { id: row.uploader_id, displayName: row.uploader_name },
    createdAt: row.created_at.toISOString(),
    downloadUrl: null,
    canDelete:
      row.uploader_id === identity.id ||
      identity.organizationRole === "ADMIN" ||
      access.projectRole === "ADMIN",
  };
}

export async function getIssueAttachments(
  identity: UserIdentity,
  access: ProjectAccess,
  issueKey: string,
): Promise<StoredAttachmentView[]> {
  const issue = await collaborationIssueId(getPool(), access, issueKey);
  if (!issue) {
    throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
  }
  const result = await getPool().query<AttachmentRow>(
    `SELECT a.id, a.object_key, a.filename, a.content_type, a.size_bytes,
            a.scan_state, a.uploader_id, u.display_name AS uploader_name,
            a.created_at
       FROM attachments a
       JOIN users u ON u.id = a.uploader_id
      WHERE a.organization_id = $1 AND a.issue_id = $2
        AND a.deleted_at IS NULL
      ORDER BY a.created_at, a.id`,
    [access.organizationId, issue.id],
  );
  return result.rows.map((row) => attachmentView(row, identity, access));
}

export async function createIssueAttachment(
  identity: UserIdentity,
  access: ProjectAccess,
  issueKey: string,
  input: {
    id: string;
    objectKey: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    scanState: AttachmentScanState;
  },
  requestCorrelationId: string = randomUUID(),
): Promise<StoredAttachmentView> {
  assertCapability(
    access.organizationRole,
    access.projectRole,
    "attachment:create",
  );
  await inTransaction(async (client) => {
    const issue = await collaborationIssueId(client, access, issueKey, true);
    if (!issue) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    const count = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM attachments
        WHERE organization_id = $1 AND issue_id = $2 AND deleted_at IS NULL`,
      [access.organizationId, issue.id],
    );
    if (Number(count.rows[0]?.count ?? 0) >= 20) {
      throw new DomainError(
        "ATTACHMENT_LIMIT_REACHED",
        "An issue can have at most 20 active attachments",
        409,
      );
    }
    await client.query(
      `INSERT INTO attachments
        (id, organization_id, issue_id, uploader_id, object_key, filename,
         content_type, size_bytes, scan_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        access.organizationId,
        issue.id,
        identity.id,
        input.objectKey,
        input.filename,
        input.contentType,
        input.sizeBytes,
        input.scanState,
      ],
    );
    const version = await client.query<{ version: number }>(
      `UPDATE issues SET version = version + 1, updated_at = now()
        WHERE id = $1 AND organization_id = $2 RETURNING version`,
      [issue.id, access.organizationId],
    );
    const payload = {
      attachmentId: input.id,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      scanState: input.scanState,
      toVersion: version.rows[0]!.version,
    };
    await client.query(
      `INSERT INTO issue_events
        (id, organization_id, issue_id, actor_id, event_type, payload_json, correlation_id)
       VALUES ($1, $2, $3, $4, 'ATTACHMENT_ADDED', $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        issue.id,
        identity.id,
        JSON.stringify(payload),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, metadata, correlation_id)
       VALUES ($1, $2, $3, 'attachment.added', 'attachment', $4, $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        identity.id,
        input.id,
        JSON.stringify({ ...payload, issueId: issue.id }),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'attachment.added', $3, $4)`,
      [
        randomUUID(),
        access.organizationId,
        input.id,
        JSON.stringify({ ...payload, issueId: issue.id }),
      ],
    );
  });
  const attachments = await getIssueAttachments(identity, access, issueKey);
  const created = attachments.find((attachment) => attachment.id === input.id);
  if (!created) throw new Error("Created attachment could not be read");
  return created;
}

export async function deleteIssueAttachment(
  identity: UserIdentity,
  access: ProjectAccess,
  issueKey: string,
  attachmentId: string,
  requestCorrelationId: string = randomUUID(),
): Promise<{ objectKey: string }> {
  assertCapability(
    access.organizationRole,
    access.projectRole,
    "attachment:delete",
  );
  return inTransaction(async (client) => {
    const issue = await collaborationIssueId(client, access, issueKey, true);
    if (!issue) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    const attachment = await client.query<{
      object_key: string;
      filename: string;
      uploader_id: string;
    }>(
      `SELECT object_key, filename, uploader_id FROM attachments
        WHERE id = $1 AND organization_id = $2 AND issue_id = $3
          AND deleted_at IS NULL
        FOR UPDATE`,
      [attachmentId, access.organizationId, issue.id],
    );
    const row = attachment.rows[0];
    if (!row) {
      throw new DomainError(
        "ATTACHMENT_NOT_FOUND",
        "Attachment not found",
        404,
      );
    }
    if (
      row.uploader_id !== identity.id &&
      identity.organizationRole !== "ADMIN" &&
      access.projectRole !== "ADMIN"
    ) {
      throw new DomainError(
        "FORBIDDEN",
        "Only the uploader or a project administrator can remove this attachment",
        403,
      );
    }
    await client.query(
      `UPDATE attachments SET deleted_at = now(), deleted_by = $4
        WHERE id = $1 AND organization_id = $2 AND issue_id = $3`,
      [attachmentId, access.organizationId, issue.id, identity.id],
    );
    const version = await client.query<{ version: number }>(
      `UPDATE issues SET version = version + 1, updated_at = now()
        WHERE id = $1 AND organization_id = $2 RETURNING version`,
      [issue.id, access.organizationId],
    );
    const payload = {
      attachmentId,
      filename: row.filename,
      toVersion: version.rows[0]!.version,
    };
    await client.query(
      `INSERT INTO issue_events
        (id, organization_id, issue_id, actor_id, event_type, payload_json, correlation_id)
       VALUES ($1, $2, $3, $4, 'ATTACHMENT_REMOVED', $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        issue.id,
        identity.id,
        JSON.stringify(payload),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, metadata, correlation_id)
       VALUES ($1, $2, $3, 'attachment.removed', 'attachment', $4, $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        identity.id,
        attachmentId,
        JSON.stringify({ ...payload, issueId: issue.id }),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'attachment.removed', $3, $4)`,
      [
        randomUUID(),
        access.organizationId,
        attachmentId,
        JSON.stringify({ ...payload, issueId: issue.id }),
      ],
    );
    return { objectKey: row.object_key };
  });
}

interface NotificationOutboxRow extends QueryResultRow {
  id: string;
  organization_id: string;
  topic: "notification.mention" | "notification.issue_commented";
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface NotificationDeliveryResult {
  processed: number;
  delivered: number;
  suppressed: number;
  failed: number;
  deadLettered: number;
}

function notificationPayload(payload: Record<string, unknown>): {
  recipientUserId: string;
  issueId: string;
  commentId: string;
  actorId: string;
} {
  const required = [
    "recipientUserId",
    "issueId",
    "commentId",
    "actorId",
  ] as const;
  for (const key of required) {
    if (
      typeof payload[key] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        payload[key],
      )
    ) {
      throw new Error(`Notification payload has an invalid ${key}`);
    }
  }
  return {
    recipientUserId: payload.recipientUserId as string,
    issueId: payload.issueId as string,
    commentId: payload.commentId as string,
    actorId: payload.actorId as string,
  };
}

function notificationClass(
  topic: NotificationOutboxRow["topic"],
): NotificationEventClass {
  return topic === "notification.mention" ? "MENTION" : "ISSUE_COMMENTED";
}

async function failOutboxDelivery(
  eventId: string,
  error: unknown,
  maxAttempts: number,
): Promise<boolean> {
  const message =
    error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error";
  const result = await getPool().query<{ dead_lettered_at: Date | null }>(
    `UPDATE outbox_events
        SET attempts = attempts + 1,
            last_error = $2,
            available_at = now() + make_interval(secs => power(2, least(attempts, 8))::int),
            dead_lettered_at = CASE WHEN attempts + 1 >= $3 THEN now() ELSE NULL END
      WHERE id = $1 AND published_at IS NULL AND dead_lettered_at IS NULL
      RETURNING dead_lettered_at`,
    [eventId, message, maxAttempts],
  );
  return result.rows[0]?.dead_lettered_at !== null;
}

export async function processNotificationOutboxBatch(
  limit = 50,
  maxAttempts = 5,
): Promise<NotificationDeliveryResult> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const result: NotificationDeliveryResult = {
    processed: 0,
    delivered: 0,
    suppressed: 0,
    failed: 0,
    deadLettered: 0,
  };
  for (let index = 0; index < boundedLimit; index += 1) {
    const client = await getPool().connect();
    let event: NotificationOutboxRow | undefined;
    try {
      await client.query("BEGIN");
      const claimed = await client.query<NotificationOutboxRow>(
        `SELECT id, organization_id, topic, payload, created_at
           FROM outbox_events
          WHERE published_at IS NULL AND dead_lettered_at IS NULL
            AND available_at <= now()
            AND topic IN ('notification.mention', 'notification.issue_commented')
          ORDER BY available_at, created_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      event = claimed.rows[0];
      if (!event) {
        await client.query("COMMIT");
        break;
      }
      const payload = notificationPayload(event.payload);
      const eventClass = notificationClass(event.topic);
      const preference = await client.query<{ enabled: boolean }>(
        `SELECT coalesce(
            (SELECT enabled FROM notification_preferences
              WHERE organization_id = $1 AND user_id = $2 AND event_class = $3),
            true
          ) AS enabled`,
        [event.organization_id, payload.recipientUserId, eventClass],
      );
      const enabled = preference.rows[0]?.enabled ?? true;
      if (enabled) {
        const inserted = await client.query(
          `INSERT INTO notifications
            (id, organization_id, recipient_user_id, source_outbox_id,
             event_class, issue_id, comment_id, actor_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (source_outbox_id) DO NOTHING`,
          [
            randomUUID(),
            event.organization_id,
            payload.recipientUserId,
            event.id,
            eventClass,
            payload.issueId,
            payload.commentId,
            payload.actorId,
            event.created_at,
          ],
        );
        result.delivered += inserted.rowCount ?? 0;
      } else {
        result.suppressed += 1;
      }
      await client.query(
        `UPDATE outbox_events
            SET published_at = now(), attempts = attempts + 1, last_error = NULL
          WHERE id = $1`,
        [event.id],
      );
      await client.query("COMMIT");
      result.processed += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      if (!event) throw error;
      result.failed += 1;
      if (await failOutboxDelivery(event.id, error, maxAttempts)) {
        result.deadLettered += 1;
      }
    } finally {
      client.release();
    }
  }
  return result;
}

interface GeneralOutboxRow extends QueryResultRow {
  id: string;
  organization_id: string;
  topic: string;
  aggregate_id: string;
  payload: unknown;
  created_at: Date;
}

export interface OutboxDeliveryResult {
  processed: number;
  delivered: number;
  replayed: number;
  failed: number;
  deadLettered: number;
}

function assertGeneralOutboxEnvelope(event: GeneralOutboxRow): void {
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(event.topic)) {
    throw new Error("Outbox topic is not a valid dotted event name");
  }
  if (
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    throw new Error("Outbox payload must be a JSON object");
  }
}

export async function processGeneralOutboxBatch(
  limit = 100,
  maxAttempts = 8,
  consumer = "internal-ledger",
): Promise<OutboxDeliveryResult> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 250));
  const boundedAttempts = Math.max(1, Math.min(Math.trunc(maxAttempts), 25));
  const result: OutboxDeliveryResult = {
    processed: 0,
    delivered: 0,
    replayed: 0,
    failed: 0,
    deadLettered: 0,
  };
  for (let index = 0; index < boundedLimit; index += 1) {
    const client = await getPool().connect();
    let event: GeneralOutboxRow | undefined;
    try {
      await client.query("BEGIN");
      const claimed = await client.query<GeneralOutboxRow>(
        `SELECT id, organization_id, topic, aggregate_id, payload, created_at
           FROM outbox_events
          WHERE published_at IS NULL AND dead_lettered_at IS NULL
            AND available_at <= now()
            AND topic NOT IN ('notification.mention', 'notification.issue_commented')
          ORDER BY available_at, created_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      event = claimed.rows[0];
      if (!event) {
        await client.query("COMMIT");
        break;
      }
      assertGeneralOutboxEnvelope(event);
      const delivered = await client.query(
        `INSERT INTO outbox_deliveries
          (id, organization_id, source_outbox_id, consumer, delivered_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (source_outbox_id, consumer) DO NOTHING`,
        [randomUUID(), event.organization_id, event.id, consumer],
      );
      if (delivered.rowCount === 1) result.delivered += 1;
      else result.replayed += 1;
      await client.query(
        `UPDATE outbox_events
            SET published_at = now(), attempts = attempts + 1, last_error = NULL
          WHERE id = $1`,
        [event.id],
      );
      await client.query("COMMIT");
      result.processed += 1;
    } catch (error) {
      await client.query("ROLLBACK");
      if (!event) throw error;
      result.failed += 1;
      if (await failOutboxDelivery(event.id, error, boundedAttempts)) {
        result.deadLettered += 1;
      }
    } finally {
      client.release();
    }
  }
  return result;
}

export async function recordWorkerHeartbeat(
  workerName: string,
  instanceId: string,
  lastError: string | null = null,
): Promise<void> {
  await getPool().query(
    `INSERT INTO worker_heartbeats
      (worker_name, instance_id, last_seen_at, last_error)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (worker_name) DO UPDATE
       SET instance_id = EXCLUDED.instance_id,
           last_seen_at = EXCLUDED.last_seen_at,
           last_error = EXCLUDED.last_error`,
    [workerName, instanceId, lastError?.slice(0, 2_000) ?? null],
  );
}

export async function outboxWorkerHealthy(
  maxAgeSeconds = 120,
): Promise<boolean> {
  const boundedAge = Math.max(10, Math.min(Math.trunc(maxAgeSeconds), 3_600));
  const result = await getPool().query<{ healthy: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM worker_heartbeats
        WHERE worker_name = 'outbox'
          AND last_seen_at >= now() - ($1 * interval '1 second')
          AND last_error IS NULL
     ) AS healthy`,
    [boundedAge],
  );
  return result.rows[0]?.healthy ?? false;
}

export async function getAuditEvents(
  identity: UserIdentity,
  query: AuditEventsQuery,
): Promise<AuditEventsView> {
  assertCapability(identity.organizationRole, null, "audit:read");
  const values: unknown[] = [identity.organizationId];
  const clauses = ["a.organization_id = $1"];
  const add = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  if (query.actorId) clauses.push(`a.actor_id = ${add(query.actorId)}`);
  if (query.action)
    clauses.push(`a.action ILIKE '%' || ${add(query.action)} || '%'`);
  if (query.targetType)
    clauses.push(`a.target_type = ${add(query.targetType)}`);
  if (query.targetId) clauses.push(`a.target_id = ${add(query.targetId)}`);
  if (query.correlationId)
    clauses.push(`a.correlation_id = ${add(query.correlationId)}`);
  if (query.from) clauses.push(`a.created_at >= ${add(query.from)}::date`);
  if (query.to)
    clauses.push(`a.created_at < ${add(query.to)}::date + interval '1 day'`);

  const cursorKind = `audit:${query.actorId ?? ""}:${query.action ?? ""}:${query.targetType ?? ""}:${query.targetId ?? ""}:${query.correlationId ?? ""}:${query.from ?? ""}:${query.to ?? ""}`;
  if (query.cursor) {
    const [createdAt, id] = decodeCursor(query.cursor, cursorKind);
    if (typeof createdAt !== "string" || typeof id !== "string") {
      throw new DomainError(
        "INVALID_CURSOR",
        "The pagination cursor is invalid or expired",
        400,
      );
    }
    const createdAtParameter = add(createdAt);
    const idParameter = add(id);
    clauses.push(
      `(a.created_at, a.id) < (${createdAtParameter}::timestamptz, ${idParameter}::uuid)`,
    );
  }
  const limitParameter = add(query.limit + 1);
  const [events, organization, actors, actions, targetTypes] =
    await Promise.all([
      getPool().query<{
        id: string;
        actor_id: string;
        display_name: string;
        email: string;
        action: string;
        target_type: string;
        target_id: string;
        metadata: Record<string, unknown>;
        correlation_id: string;
        created_at: Date;
      }>(
        `SELECT a.id, a.actor_id, u.display_name, u.email, a.action,
                a.target_type, a.target_id, a.metadata, a.correlation_id,
                a.created_at
           FROM audit_events a
           JOIN users u ON u.id = a.actor_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${limitParameter}`,
        values,
      ),
      getPool().query<{
        audit_retention_days: number;
        audit_retention_version: number;
      }>(
        `SELECT audit_retention_days, audit_retention_version
           FROM organizations WHERE id = $1`,
        [identity.organizationId],
      ),
      getPool().query<{
        id: string;
        display_name: string;
        email: string;
      }>(
        `SELECT DISTINCT u.id, u.display_name, u.email
           FROM audit_events a JOIN users u ON u.id = a.actor_id
          WHERE a.organization_id = $1
          ORDER BY u.display_name, u.id`,
        [identity.organizationId],
      ),
      getPool().query<{ action: string }>(
        `SELECT DISTINCT action FROM audit_events
          WHERE organization_id = $1 ORDER BY action`,
        [identity.organizationId],
      ),
      getPool().query<{ target_type: string }>(
        `SELECT DISTINCT target_type FROM audit_events
          WHERE organization_id = $1 ORDER BY target_type`,
        [identity.organizationId],
      ),
    ]);
  const hasMore = events.rows.length > query.limit;
  const rows = events.rows.slice(0, query.limit);
  const last = rows.at(-1);
  const retention = organization.rows[0];
  if (!retention) {
    throw new DomainError(
      "ORGANIZATION_NOT_FOUND",
      "Organization not found",
      404,
    );
  }
  return {
    items: rows.map((row) => ({
      id: row.id,
      actor: {
        id: row.actor_id,
        displayName: row.display_name,
        email: row.email,
      },
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata,
      correlationId: row.correlation_id,
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor(cursorKind, [last.created_at.toISOString(), last.id])
        : null,
    retention: {
      days: retention.audit_retention_days,
      version: retention.audit_retention_version,
    },
    facets: {
      actors: actors.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        email: row.email,
      })),
      actions: actions.rows.map((row) => row.action),
      targetTypes: targetTypes.rows.map((row) => row.target_type),
    },
  };
}

export async function updateAuditRetention(
  identity: UserIdentity,
  days: number,
  version: number,
  requestCorrelationId: string = randomUUID(),
): Promise<{ days: number; version: number }> {
  assertCapability(identity.organizationRole, null, "audit:read");
  return inTransaction(async (client) => {
    const updated = await client.query<{
      audit_retention_days: number;
      audit_retention_version: number;
    }>(
      `UPDATE organizations
          SET audit_retention_days = $1,
              audit_retention_version = audit_retention_version + 1
        WHERE id = $2 AND audit_retention_version = $3
        RETURNING audit_retention_days, audit_retention_version`,
      [days, identity.organizationId, version],
    );
    const row = updated.rows[0];
    if (!row) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "The audit retention policy changed. Refresh and try again.",
        409,
      );
    }
    const auditId = randomUUID();
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, 'audit.retention_updated', 'organization', $2,
               $4, $5)`,
      [
        auditId,
        identity.organizationId,
        identity.id,
        JSON.stringify({ days: row.audit_retention_days }),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'audit.retention_updated', $2, $3)`,
      [
        randomUUID(),
        identity.organizationId,
        JSON.stringify({ auditId, days: row.audit_retention_days }),
      ],
    );
    return {
      days: row.audit_retention_days,
      version: row.audit_retention_version,
    };
  });
}

export async function pruneExpiredAuditEvents(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM audit_events a
      USING organizations o
      WHERE a.organization_id = o.id
        AND a.created_at < now() - (o.audit_retention_days * interval '1 day')`,
  );
  return result.rowCount ?? 0;
}

function assertOrganizationAdministration(identity: UserIdentity): void {
  assertCapability(identity.organizationRole, null, "organization:admin");
}

export async function getAdministrationSettings(
  identity: UserIdentity,
): Promise<AdministrationSettingsView> {
  assertOrganizationAdministration(identity);
  const [organization, users, projects] = await Promise.all([
    getPool().query<{ id: string; name: string; version: number }>(
      `SELECT id, name, version FROM organizations WHERE id = $1`,
      [identity.organizationId],
    ),
    getPool().query<{
      id: string;
      email: string;
      display_name: string;
      state: AdministrationUserView["state"];
      organization_role: AdministrationUserView["organizationRole"];
      version: number;
      active_assignments: string;
    }>(
      `SELECT u.id, u.email, u.display_name, u.state, m.organization_role,
              u.version,
              (SELECT count(*) FROM issues i
                JOIN projects p ON p.id = i.project_id
               WHERE i.organization_id = u.organization_id
                 AND i.assignee_id = u.id AND i.deleted_at IS NULL
                 AND p.archived_at IS NULL) AS active_assignments
         FROM users u
         JOIN memberships m
           ON m.organization_id = u.organization_id AND m.user_id = u.id
        WHERE u.organization_id = $1
        ORDER BY u.display_name, u.id`,
      [identity.organizationId],
    ),
    getPool().query<{
      id: string;
      project_key: string;
      name: string;
      version: number;
      archived: boolean;
      board_id: string;
      board_name: string;
      board_version: number;
      issue_count: string;
      member_count: string;
    }>(
      `SELECT p.id, p.project_key, p.name, p.version,
              p.archived_at IS NOT NULL AS archived,
              b.id AS board_id, b.name AS board_name, b.version AS board_version,
              (SELECT count(*) FROM issues i WHERE i.project_id = p.id) AS issue_count,
              (SELECT count(*) FROM effective_project_members pm
                WHERE pm.project_id = p.id) AS member_count
         FROM projects p
         JOIN boards b ON b.project_id = p.id AND b.organization_id = p.organization_id
        WHERE p.organization_id = $1
        ORDER BY p.archived_at NULLS FIRST, p.name, p.id`,
      [identity.organizationId],
    ),
  ]);
  const organizationRow = organization.rows[0];
  if (!organizationRow) {
    throw new DomainError(
      "ORGANIZATION_NOT_FOUND",
      "Organization not found",
      404,
    );
  }
  return {
    organization: organizationRow,
    users: users.rows.map((row): AdministrationUserView => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      state: row.state,
      organizationRole: row.organization_role,
      version: row.version,
      activeAssignments: Number(row.active_assignments),
    })),
    projects: projects.rows.map((row): AdministrationProjectView => ({
      id: row.id,
      key: row.project_key,
      name: row.name,
      board: {
        id: row.board_id,
        name: row.board_name,
        version: row.board_version,
      },
      version: row.version,
      archived: row.archived,
      issueCount: Number(row.issue_count),
      memberCount: Number(row.member_count),
    })),
  };
}

export async function updateOrganizationSettings(
  identity: UserIdentity,
  input: UpdateOrganizationSettingsInput,
  requestCorrelationId: string = randomUUID(),
): Promise<void> {
  assertOrganizationAdministration(identity);
  await inTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE organizations SET name = $1, version = version + 1
        WHERE id = $2 AND version = $3`,
      [input.name, identity.organizationId, input.version],
    );
    if (updated.rowCount !== 1) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "The organization settings changed. Refresh and try again.",
        409,
      );
    }
    const auditId = randomUUID();
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, 'organization.updated', 'organization', $2,
               $4, $5)`,
      [
        auditId,
        identity.organizationId,
        identity.id,
        JSON.stringify({ name: input.name }),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'organization.updated', $2, $3)`,
      [
        randomUUID(),
        identity.organizationId,
        JSON.stringify({ auditId, name: input.name }),
      ],
    );
  });
}

export async function updateOrganizationUser(
  identity: UserIdentity,
  userId: string,
  input: UpdateOrganizationUserInput,
  requestCorrelationId: string = randomUUID(),
): Promise<void> {
  assertOrganizationAdministration(identity);
  await inTransaction(async (client) => {
    const existing = await client.query<{
      state: AdministrationUserView["state"];
      organization_role: AdministrationUserView["organizationRole"];
      version: number;
    }>(
      `SELECT u.state, m.organization_role, u.version
         FROM users u
         JOIN memberships m
           ON m.organization_id = u.organization_id AND m.user_id = u.id
        WHERE u.id = $1 AND u.organization_id = $2
        FOR UPDATE OF u, m`,
      [userId, identity.organizationId],
    );
    const current = existing.rows[0];
    if (!current) {
      throw new DomainError(
        "USER_NOT_FOUND",
        "Organization user not found",
        404,
      );
    }
    if (current.version !== input.version) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "The user changed. Refresh and try again.",
        409,
      );
    }
    const removesActiveAdmin =
      current.state === "ACTIVE" &&
      current.organization_role === "ADMIN" &&
      (input.state !== "ACTIVE" || input.organizationRole !== "ADMIN");
    if (removesActiveAdmin) {
      const others = await client.query<{ count: string }>(
        `SELECT count(*) AS count
           FROM users u JOIN memberships m
             ON m.organization_id = u.organization_id AND m.user_id = u.id
          WHERE u.organization_id = $1 AND u.id <> $2
            AND u.state = 'ACTIVE' AND m.organization_role = 'ADMIN'`,
        [identity.organizationId, userId],
      );
      if (Number(others.rows[0]?.count ?? 0) === 0) {
        throw new DomainError(
          "LAST_ORGANIZATION_ADMIN",
          "The organization must keep at least one active administrator",
          409,
        );
      }
    }
    if (input.state === "INACTIVE" && current.state !== "INACTIVE") {
      const assignments = await client.query(
        `SELECT i.id FROM issues i JOIN projects p ON p.id = i.project_id
          WHERE i.organization_id = $1 AND i.assignee_id = $2
            AND i.deleted_at IS NULL AND p.archived_at IS NULL LIMIT 1`,
        [identity.organizationId, userId],
      );
      if (assignments.rows[0]) {
        throw new DomainError(
          "USER_HAS_ACTIVE_ASSIGNMENTS",
          "Reassign active issues before deactivating this user",
          409,
        );
      }
    }
    await client.query(
      `UPDATE users SET state = $1, version = version + 1
        WHERE id = $2 AND organization_id = $3`,
      [input.state, userId, identity.organizationId],
    );
    await client.query(
      `UPDATE memberships SET organization_role = $1
        WHERE organization_id = $2 AND user_id = $3`,
      [input.organizationRole, identity.organizationId, userId],
    );
    const auditId = randomUUID();
    const metadata = {
      previousState: current.state,
      state: input.state,
      previousOrganizationRole: current.organization_role,
      organizationRole: input.organizationRole,
    };
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, 'user.updated', 'user', $4, $5, $6)`,
      [
        auditId,
        identity.organizationId,
        identity.id,
        userId,
        JSON.stringify(metadata),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'user.updated', $3, $4)`,
      [
        randomUUID(),
        identity.organizationId,
        userId,
        JSON.stringify({ auditId, ...metadata }),
      ],
    );
  });
}

export async function inviteOrganizationUser(
  identity: UserIdentity,
  input: InviteOrganizationUserInput,
  publicBaseUrl: string,
  requestCorrelationId: string = randomUUID(),
): Promise<{ activationUrl: string; expiresAt: string }> {
  assertOrganizationAdministration(identity);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1_000);
  await inTransaction(async (client) => {
    const userId = randomUUID();
    try {
      await client.query(
        `INSERT INTO users
          (id, organization_id, email, display_name, password_hash, state)
         VALUES ($1, $2, lower($3), $4, '!invited', 'INVITED')`,
        [userId, identity.organizationId, input.email, input.displayName],
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new DomainError(
          "USER_EMAIL_TAKEN",
          "A user with that email already exists",
          409,
        );
      }
      throw error;
    }
    await client.query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, $3)`,
      [identity.organizationId, userId, input.organizationRole],
    );
    await client.query(
      `INSERT INTO user_invitations
        (id, organization_id, user_id, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        identity.organizationId,
        userId,
        tokenHash,
        identity.id,
        expiresAt,
      ],
    );
    const auditId = randomUUID();
    const metadata = {
      email: input.email.toLocaleLowerCase(),
      organizationRole: input.organizationRole,
      expiresAt: expiresAt.toISOString(),
    };
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, 'user.invited', 'user', $4, $5, $6)`,
      [
        auditId,
        identity.organizationId,
        identity.id,
        userId,
        JSON.stringify(metadata),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'user.invited', $3, $4)`,
      [
        randomUUID(),
        identity.organizationId,
        userId,
        JSON.stringify({ auditId, userId, ...metadata }),
      ],
    );
  });
  return {
    activationUrl: `${publicBaseUrl.replace(/\/$/, "")}/invite/${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function acceptUserInvitation(
  token: string,
  password: string,
  requestCorrelationId: string = randomUUID(),
): Promise<string> {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const passwordHash = await hashPassword(password);
  return inTransaction(async (client) => {
    const invitation = await client.query<{
      id: string;
      organization_id: string;
      user_id: string;
      expires_at: Date;
      accepted_at: Date | null;
      state: AdministrationUserView["state"];
    }>(
      `SELECT invitation.id, invitation.organization_id, invitation.user_id,
              invitation.expires_at, invitation.accepted_at, u.state
         FROM user_invitations invitation
         JOIN users u ON u.id = invitation.user_id
        WHERE invitation.token_hash = $1
        FOR UPDATE OF invitation, u`,
      [tokenHash],
    );
    const row = invitation.rows[0];
    if (
      !row ||
      row.accepted_at ||
      row.expires_at <= new Date() ||
      row.state !== "INVITED"
    ) {
      throw new DomainError(
        "INVITATION_INVALID",
        "This invitation is invalid, expired, or already used",
        410,
      );
    }
    await client.query(
      `UPDATE users
          SET password_hash = $1, state = 'ACTIVE', version = version + 1
        WHERE id = $2 AND organization_id = $3`,
      [passwordHash, row.user_id, row.organization_id],
    );
    await client.query(
      `UPDATE user_invitations SET accepted_at = now() WHERE id = $1`,
      [row.id],
    );
    const auditId = randomUUID();
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, 'user.activated', 'user', $3, '{}', $4)`,
      [auditId, row.organization_id, row.user_id, requestCorrelationId],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'user.activated', $3, $4)`,
      [
        randomUUID(),
        row.organization_id,
        row.user_id,
        JSON.stringify({ auditId, userId: row.user_id }),
      ],
    );
    return row.user_id;
  });
}

async function teamAdministrationEvent(
  client: PoolClient,
  identity: UserIdentity,
  teamId: string,
  action: string,
  metadata: Record<string, unknown>,
  correlationId: string,
): Promise<void> {
  const auditId = randomUUID();
  await client.query(
    `INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id,
       metadata, correlation_id)
     VALUES ($1, $2, $3, $4, 'team', $5, $6, $7)`,
    [
      auditId,
      identity.organizationId,
      identity.id,
      action,
      teamId,
      JSON.stringify(metadata),
      correlationId,
    ],
  );
  await client.query(
    `INSERT INTO outbox_events
      (id, organization_id, topic, aggregate_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomUUID(),
      identity.organizationId,
      action,
      teamId,
      JSON.stringify({ auditId, teamId, ...metadata }),
    ],
  );
}

export async function getAdministrationTeams(
  identity: UserIdentity,
): Promise<AdministrationTeamsView> {
  assertOrganizationAdministration(identity);
  const [users, teams] = await Promise.all([
    getPool().query<{ id: string; display_name: string; email: string }>(
      `SELECT id, display_name, email FROM users
        WHERE organization_id = $1 AND state = 'ACTIVE'
        ORDER BY display_name, id`,
      [identity.organizationId],
    ),
    getPool().query<{
      id: string;
      name: string;
      version: number;
      members: Array<{ id: string; displayName: string; email: string }>;
    }>(
      `SELECT team.id, team.name, team.version,
              coalesce(jsonb_agg(jsonb_build_object(
                'id', u.id, 'displayName', u.display_name, 'email', u.email
              ) ORDER BY u.display_name, u.id)
                FILTER (WHERE u.id IS NOT NULL), '[]'::jsonb) AS members
         FROM teams team
         LEFT JOIN team_members member ON member.team_id = team.id
         LEFT JOIN users u ON u.id = member.user_id AND u.state = 'ACTIVE'
        WHERE team.organization_id = $1
        GROUP BY team.id
        ORDER BY team.name, team.id`,
      [identity.organizationId],
    ),
  ]);
  return {
    users: users.rows.map((user) => ({
      id: user.id,
      displayName: user.display_name,
      email: user.email,
    })),
    teams: teams.rows,
  };
}

export async function createTeam(
  identity: UserIdentity,
  name: string,
  correlationId: string = randomUUID(),
): Promise<void> {
  assertOrganizationAdministration(identity);
  await inTransaction(async (client) => {
    const teamId = randomUUID();
    await client.query(
      `INSERT INTO teams (id, organization_id, name) VALUES ($1, $2, $3)`,
      [teamId, identity.organizationId, name],
    );
    await teamAdministrationEvent(
      client,
      identity,
      teamId,
      "team.created",
      { name },
      correlationId,
    );
  });
}

export async function updateTeam(
  identity: UserIdentity,
  teamId: string,
  input: { name: string; memberIds: string[]; version: number },
  correlationId: string = randomUUID(),
): Promise<void> {
  assertOrganizationAdministration(identity);
  await inTransaction(async (client) => {
    const team = await client.query<{ version: number }>(
      `SELECT version FROM teams
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [teamId, identity.organizationId],
    );
    if (!team.rows[0])
      throw new DomainError("TEAM_NOT_FOUND", "Team not found", 404);
    assertVersion(input.version, team.rows[0].version);
    const uniqueMembers = [...new Set(input.memberIds)];
    const valid = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE organization_id = $1 AND state = 'ACTIVE'
        AND id = ANY($2::uuid[])`,
      [identity.organizationId, uniqueMembers],
    );
    if (valid.rows.length !== uniqueMembers.length) {
      throw new DomainError(
        "INVALID_TEAM_MEMBER",
        "Every team member must be an active organization user",
        422,
      );
    }
    await client.query(
      `UPDATE teams SET name = $1, version = version + 1
        WHERE id = $2 AND organization_id = $3`,
      [input.name, teamId, identity.organizationId],
    );
    await client.query(
      `DELETE FROM team_members WHERE organization_id = $1 AND team_id = $2`,
      [identity.organizationId, teamId],
    );
    if (uniqueMembers.length > 0) {
      await client.query(
        `INSERT INTO team_members (organization_id, team_id, user_id)
         SELECT $1, $2, unnest($3::uuid[])`,
        [identity.organizationId, teamId, uniqueMembers],
      );
    }
    await teamAdministrationEvent(
      client,
      identity,
      teamId,
      "team.updated",
      { name: input.name, memberIds: uniqueMembers },
      correlationId,
    );
  });
}

export async function getProjectTeams(
  identity: UserIdentity,
  access: ProjectAccess,
): Promise<ProjectTeamsView> {
  assertMembershipAdministration(identity, access);
  const [project, teams] = await Promise.all([
    getPool().query<{
      id: string;
      project_key: string;
      name: string;
      board_id: string;
    }>(
      `SELECT p.id, p.project_key, p.name, b.id AS board_id
         FROM projects p JOIN boards b ON b.project_id = p.id
        WHERE p.id = $1 AND p.organization_id = $2 LIMIT 1`,
      [access.projectId, access.organizationId],
    ),
    getPool().query<{
      id: string;
      name: string;
      member_count: string;
      project_role: ProjectRole | null;
    }>(
      `SELECT team.id, team.name,
              (SELECT count(*) FROM team_members member
                JOIN users u ON u.id = member.user_id AND u.state = 'ACTIVE'
               WHERE member.team_id = team.id) AS member_count,
              assignment.role AS project_role
         FROM teams team
         LEFT JOIN project_team_members assignment
           ON assignment.team_id = team.id AND assignment.project_id = $2
        WHERE team.organization_id = $1
        ORDER BY team.name, team.id`,
      [access.organizationId, access.projectId],
    ),
  ]);
  const projectRow = project.rows[0];
  if (!projectRow)
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  return {
    project: {
      id: projectRow.id,
      key: projectRow.project_key,
      name: projectRow.name,
      boardId: projectRow.board_id,
    },
    teams: teams.rows.map((team) => ({
      id: team.id,
      name: team.name,
      memberCount: Number(team.member_count),
      projectRole: team.project_role,
    })),
  };
}

export async function setProjectTeam(
  identity: UserIdentity,
  access: ProjectAccess,
  teamId: string,
  role: ProjectRole | null,
  correlationId: string = randomUUID(),
): Promise<void> {
  assertMembershipAdministration(identity, access);
  await inTransaction(async (client) => {
    const team = await client.query(
      `SELECT id FROM teams WHERE id = $1 AND organization_id = $2`,
      [teamId, access.organizationId],
    );
    if (!team.rows[0])
      throw new DomainError("TEAM_NOT_FOUND", "Team not found", 404);
    if (role) {
      await client.query(
        `INSERT INTO project_team_members
          (organization_id, project_id, team_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, team_id) DO UPDATE SET role = EXCLUDED.role`,
        [access.organizationId, access.projectId, teamId, role],
      );
    } else {
      await client.query(
        `DELETE FROM project_team_members
          WHERE organization_id = $1 AND project_id = $2 AND team_id = $3`,
        [access.organizationId, access.projectId, teamId],
      );
    }
    const admins = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM effective_project_members
        WHERE organization_id = $1 AND project_id = $2 AND role = 'ADMIN'`,
      [access.organizationId, access.projectId],
    );
    if (Number(admins.rows[0]?.count ?? 0) === 0) {
      throw new DomainError(
        "LAST_PROJECT_ADMIN",
        "The project must keep at least one administrator",
        409,
      );
    }
    await teamAdministrationEvent(
      client,
      identity,
      teamId,
      role ? "project.team_role_changed" : "project.team_removed",
      { projectId: access.projectId, role },
      correlationId,
    );
  });
}

export async function updateAdminProject(
  identity: UserIdentity,
  projectId: string,
  input: UpdateAdminProjectInput,
  requestCorrelationId: string = randomUUID(),
): Promise<void> {
  assertOrganizationAdministration(identity);
  await inTransaction(async (client) => {
    const existing = await client.query<{
      archived: boolean;
      board_id: string;
      project_version: number;
      board_version: number;
    }>(
      `SELECT p.archived_at IS NOT NULL AS archived, p.version AS project_version,
              b.id AS board_id, b.version AS board_version
         FROM projects p JOIN boards b ON b.project_id = p.id
        WHERE p.id = $1 AND p.organization_id = $2
        FOR UPDATE OF p, b`,
      [projectId, identity.organizationId],
    );
    const current = existing.rows[0];
    if (!current) {
      throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    if (
      current.project_version !== input.version ||
      current.board_version !== input.boardVersion
    ) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "The project settings changed. Refresh and try again.",
        409,
      );
    }
    await client.query(
      `UPDATE projects
          SET name = $1,
              archived_at = CASE WHEN $2 THEN coalesce(archived_at, now()) ELSE NULL END,
              version = version + 1
        WHERE id = $3 AND organization_id = $4`,
      [input.name, input.archived, projectId, identity.organizationId],
    );
    await client.query(
      `UPDATE boards SET name = $1, version = version + 1
        WHERE id = $2 AND organization_id = $3`,
      [input.boardName, current.board_id, identity.organizationId],
    );
    const action =
      !current.archived && input.archived
        ? "project.archived"
        : current.archived && !input.archived
          ? "project.restored"
          : "project.updated";
    const auditId = randomUUID();
    const metadata = {
      name: input.name,
      boardName: input.boardName,
      archived: input.archived,
    };
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, $4, 'project', $5, $6, $7)`,
      [
        auditId,
        identity.organizationId,
        identity.id,
        action,
        projectId,
        JSON.stringify(metadata),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        identity.organizationId,
        action,
        projectId,
        JSON.stringify({ auditId, ...metadata }),
      ],
    );
  });
}

function assertDataAdministration(
  identity: UserIdentity,
  access: ProjectAccess,
): void {
  if (identity.organizationId !== access.organizationId) {
    throw new DomainError(
      "FORBIDDEN",
      "You do not have permission to perform this action",
      403,
    );
  }
  assertCapability(access.organizationRole, access.projectRole, "data:manage");
}

function toDataJob(row: {
  id: string;
  job_type: DataJobView["jobType"];
  state: DataJobView["state"];
  attempts: number;
  result_json: Record<string, unknown>;
  error_message: string | null;
  output_text: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}): DataJobView {
  return {
    id: row.id,
    jobType: row.job_type,
    state: row.state,
    attempts: row.attempts,
    result: row.result_json,
    errorMessage: row.error_message,
    canDownload: row.state === "SUCCEEDED" && row.output_text !== null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export function dryRunIssueCsv(csv: string): CsvValidationReport {
  return validateIssueCsv(csv).report;
}

export async function createDataJob(
  identity: UserIdentity,
  access: ProjectAccess,
  input:
    | {
        jobType: "CSV_IMPORT";
        csv: string;
        invalidRowPolicy: CsvImportPolicy;
      }
    | { jobType: "CSV_EXPORT" },
  idempotencyKey: string,
  requestCorrelationId: string = randomUUID(),
): Promise<DataJobView> {
  assertDataAdministration(identity, access);
  let report: CsvValidationReport | null = null;
  if (input.jobType === "CSV_IMPORT") {
    report = validateIssueCsv(input.csv).report;
    if (report.validRows === 0) {
      throw new DomainError(
        "CSV_NO_VALID_ROWS",
        "The CSV does not contain any valid issue rows",
        422,
      );
    }
    if (input.invalidRowPolicy === "ATOMIC" && report.invalidRows > 0) {
      throw new DomainError(
        "CSV_VALIDATION_FAILED",
        "Atomic import requires every CSV row to be valid",
        422,
      );
    }
  }
  const requestHash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  return inTransaction(async (client) => {
    const id = randomUUID();
    const inserted = await client.query<{
      id: string;
      job_type: DataJobView["jobType"];
      state: DataJobView["state"];
      attempts: number;
      result_json: Record<string, unknown>;
      error_message: string | null;
      output_text: string | null;
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `INSERT INTO data_jobs
        (id, organization_id, project_id, actor_id, job_type,
         idempotency_key, request_hash, input_text, input_options, result_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (organization_id, actor_id, job_type, idempotency_key)
       DO NOTHING
       RETURNING *`,
      [
        id,
        access.organizationId,
        access.projectId,
        identity.id,
        input.jobType,
        idempotencyKey,
        requestHash,
        input.jobType === "CSV_IMPORT" ? input.csv : null,
        JSON.stringify(
          input.jobType === "CSV_IMPORT"
            ? { invalidRowPolicy: input.invalidRowPolicy }
            : {},
        ),
        JSON.stringify(report ? { validation: report } : {}),
      ],
    );
    const row = inserted.rows[0];
    if (!row) {
      const existing = await client.query<
        (typeof inserted.rows)[number] & { request_hash: string }
      >(
        `SELECT * FROM data_jobs
          WHERE organization_id = $1 AND actor_id = $2
            AND job_type = $3 AND idempotency_key = $4
          FOR UPDATE`,
        [access.organizationId, identity.id, input.jobType, idempotencyKey],
      );
      const existingRow = existing.rows[0];
      if (!existingRow || existingRow.request_hash !== requestHash) {
        throw new DomainError(
          "IDEMPOTENCY_KEY_REUSED",
          "That Idempotency-Key was already used with a different request",
          409,
        );
      }
      return toDataJob(existingRow);
    }
    const auditId = randomUUID();
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, 'data_job.created', 'data_job', $4, $5, $6)`,
      [
        auditId,
        access.organizationId,
        identity.id,
        id,
        JSON.stringify({
          jobType: input.jobType,
          projectId: access.projectId,
          validation: report,
        }),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'data_job.created', $3, $4)`,
      [
        randomUUID(),
        access.organizationId,
        id,
        JSON.stringify({ auditId, jobId: id, jobType: input.jobType }),
      ],
    );
    return toDataJob(row);
  });
}

export async function getDataJobs(
  identity: UserIdentity,
  access: ProjectAccess,
): Promise<DataJobsView> {
  assertDataAdministration(identity, access);
  const [project, jobs] = await Promise.all([
    getPool().query<{
      id: string;
      project_key: string;
      name: string;
      board_id: string;
    }>(
      `SELECT p.id, p.project_key, p.name, b.id AS board_id
         FROM projects p JOIN boards b ON b.project_id = p.id
        WHERE p.id = $1 AND p.organization_id = $2 AND p.archived_at IS NULL`,
      [access.projectId, access.organizationId],
    ),
    getPool().query<{
      id: string;
      job_type: DataJobView["jobType"];
      state: DataJobView["state"];
      attempts: number;
      result_json: Record<string, unknown>;
      error_message: string | null;
      output_text: string | null;
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT id, job_type, state, attempts, result_json, error_message,
              output_text, created_at, started_at, completed_at
         FROM data_jobs
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC LIMIT 50`,
      [access.organizationId, access.projectId],
    ),
  ]);
  const row = project.rows[0];
  if (!row)
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  return {
    project: {
      id: row.id,
      key: row.project_key,
      name: row.name,
      boardId: row.board_id,
    },
    jobs: jobs.rows.map(toDataJob),
  };
}

async function completeDataJob(job: {
  id: string;
  organization_id: string;
  project_id: string;
  actor_id: string;
  job_type: DataJobView["jobType"];
  input_text: string | null;
  input_options: { invalidRowPolicy?: CsvImportPolicy };
}): Promise<{ result: Record<string, unknown>; output: string | null }> {
  const project = await getPool().query<{ project_key: string }>(
    `SELECT project_key FROM projects
      WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
    [job.project_id, job.organization_id],
  );
  const projectKey = project.rows[0]?.project_key;
  if (!projectKey) throw new Error("Project is no longer active");
  const identity = await getIdentity(job.actor_id);
  if (!identity) throw new Error("The job actor is no longer active");
  const access = await getProjectAccess(job.actor_id, projectKey);
  if (
    !access ||
    !can(access.organizationRole, access.projectRole, "data:manage")
  ) {
    throw new Error("The job actor no longer administers this project");
  }
  if (job.job_type === "CSV_IMPORT") {
    const validation = validateIssueCsv(job.input_text ?? "");
    const keys: string[] = [];
    for (const row of validation.rows) {
      const issue = await createIssue(
        identity,
        access,
        {
          summary: row.summary,
          description: row.description,
          issueType: row.issueType,
          priority: row.priority,
          labels: row.labels,
          estimatePoints: row.estimatePoints,
          dueDate: row.dueDate,
        },
        job.id,
      );
      keys.push(issue.key);
    }
    return {
      result: {
        imported: keys.length,
        skipped:
          job.input_options.invalidRowPolicy === "SKIP_INVALID"
            ? validation.report.invalidRows
            : 0,
        issueKeys: keys,
        validation: validation.report,
      },
      output: null,
    };
  }
  const exported = await getPool().query<{
    issue_key: string;
    summary: string;
    description: string;
    issue_type: string;
    status: string;
    priority: string;
    assignee: string | null;
    labels: string[];
    estimate_points: number | null;
    due_date: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT p.project_key || '-' || i.number AS issue_key, i.summary,
            coalesce(i.description, '') AS description, it.name AS issue_type,
            s.name AS status, i.priority, i.estimate_points, i.due_date::text,
            assignee.email AS assignee,
            ARRAY(SELECT l.display_name FROM issue_labels il
                    JOIN labels l ON l.id = il.label_id
                   WHERE il.issue_id = i.id ORDER BY l.normalized_name) AS labels,
            i.created_at, i.updated_at
       FROM issues i JOIN projects p ON p.id = i.project_id
       JOIN issue_types it ON it.id = i.issue_type_id
       JOIN statuses s ON s.id = i.status_id
       LEFT JOIN users assignee ON assignee.id = i.assignee_id
      WHERE i.organization_id = $1 AND i.project_id = $2
      ORDER BY i.number`,
    [job.organization_id, job.project_id],
  );
  const lines = [
    csvLine([
      "Key",
      "Summary",
      "Description",
      "Issue Type",
      "Status",
      "Priority",
      "Assignee",
      "Labels",
      "Estimate Points",
      "Due Date",
      "Created",
      "Updated",
    ]),
    ...exported.rows.map((row) =>
      csvLine([
        row.issue_key,
        row.summary,
        row.description,
        row.issue_type,
        row.status,
        row.priority,
        row.assignee,
        row.labels.join("|"),
        row.estimate_points,
        row.due_date,
        row.created_at.toISOString(),
        row.updated_at.toISOString(),
      ]),
    ),
  ];
  return {
    result: { exported: exported.rows.length },
    output: `${lines.join("\r\n")}\r\n`,
  };
}

export async function processDataJobBatch(limit = 5): Promise<{
  processed: number;
  failed: number;
}> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 25));
  const claimed = await inTransaction(async (client) => {
    const jobs = await client.query<{
      id: string;
      organization_id: string;
      project_id: string;
      actor_id: string;
      job_type: DataJobView["jobType"];
      input_text: string | null;
      input_options: { invalidRowPolicy?: CsvImportPolicy };
    }>(
      `SELECT id, organization_id, project_id, actor_id, job_type,
              input_text, input_options
         FROM data_jobs WHERE state = 'QUEUED'
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED LIMIT $1`,
      [boundedLimit],
    );
    if (jobs.rows.length > 0) {
      await client.query(
        `UPDATE data_jobs SET state = 'RUNNING', started_at = now(),
                              attempts = attempts + 1
          WHERE id = ANY($1::uuid[])`,
        [jobs.rows.map((job) => job.id)],
      );
    }
    return jobs.rows;
  });
  let processed = 0;
  let failed = 0;
  for (const job of claimed) {
    try {
      const completed = await completeDataJob(job);
      await inTransaction(async (client) => {
        await client.query(
          `UPDATE data_jobs
              SET state = 'SUCCEEDED', result_json = $1, output_text = $2,
                  error_message = NULL, completed_at = now()
            WHERE id = $3 AND state = 'RUNNING'`,
          [JSON.stringify(completed.result), completed.output, job.id],
        );
        const auditId = randomUUID();
        await client.query(
          `INSERT INTO audit_events
            (id, organization_id, actor_id, action, target_type, target_id,
             metadata, correlation_id)
           VALUES ($1, $2, $3, 'data_job.succeeded', 'data_job', $4, $5, $4)`,
          [
            auditId,
            job.organization_id,
            job.actor_id,
            job.id,
            JSON.stringify(completed.result),
          ],
        );
        await client.query(
          `INSERT INTO outbox_events
            (id, organization_id, topic, aggregate_id, payload)
           VALUES ($1, $2, 'data_job.succeeded', $3, $4)`,
          [
            randomUUID(),
            job.organization_id,
            job.id,
            JSON.stringify({ auditId, jobId: job.id, ...completed.result }),
          ],
        );
      });
      processed += 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown job error";
      await getPool().query(
        `UPDATE data_jobs SET state = 'FAILED', error_message = $1,
                              completed_at = now()
          WHERE id = $2 AND state = 'RUNNING'`,
        [message.slice(0, 2_000), job.id],
      );
      failed += 1;
    }
  }
  return { processed, failed };
}

export async function getDataJobDownload(
  identity: UserIdentity,
  access: ProjectAccess,
  jobId: string,
): Promise<string> {
  assertDataAdministration(identity, access);
  const result = await getPool().query<{ output_text: string | null }>(
    `SELECT output_text FROM data_jobs
      WHERE id = $1 AND organization_id = $2 AND project_id = $3
        AND job_type = 'CSV_EXPORT' AND state = 'SUCCEEDED'`,
    [jobId, access.organizationId, access.projectId],
  );
  const output = result.rows[0]?.output_text;
  if (!output) {
    throw new DomainError("JOB_OUTPUT_NOT_FOUND", "Export is not ready", 404);
  }
  return output;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function eachUtcDate(from: Date, to: Date): Date[] {
  const dates: Date[] = [];
  for (
    let cursor = new Date(from);
    cursor <= to;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    dates.push(cursor);
  }
  return dates;
}

function average(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

export async function getKanbanReports(
  identity: UserIdentity,
  access: ProjectAccess,
  query: ReportsQuery,
): Promise<KanbanReportsView> {
  if (identity.organizationId !== access.organizationId) {
    throw new DomainError(
      "FORBIDDEN",
      "You do not have permission to perform this action",
      403,
    );
  }
  assertCapability(access.organizationRole, access.projectRole, "issue:view");
  const today = new Date();
  const defaultFrom = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - 29,
    ),
  );
  const from = new Date(`${query.from ?? utcDate(defaultFrom)}T00:00:00.000Z`);
  const requestedTo = new Date(`${query.to ?? utcDate(today)}T23:59:59.999Z`);
  const asOf = requestedTo > today ? today : requestedTo;
  if (asOf < from || asOf.getTime() - from.getTime() > 366 * 86_400_000) {
    throw new DomainError(
      "INVALID_REPORT_PERIOD",
      "Report periods must span 1 to 367 days",
      400,
    );
  }
  const [project, issueRowsResult, events] = await Promise.all([
    getPool().query<{
      id: string;
      project_key: string;
      name: string;
      board_id: string;
    }>(
      `SELECT p.id, p.project_key, p.name, b.id AS board_id
         FROM projects p JOIN boards b ON b.project_id = p.id
        WHERE p.id = $1 AND p.organization_id = $2 AND p.archived_at IS NULL`,
      [access.projectId, access.organizationId],
    ),
    getPool().query<{
      id: string;
      issue_key: string;
      summary: string;
      created_at: Date;
      current_category: StatusCategory;
    }>(
      `SELECT i.id, p.project_key || '-' || i.number AS issue_key, i.summary,
              i.created_at, s.category AS current_category
         FROM issues i JOIN projects p ON p.id = i.project_id
         JOIN statuses s ON s.id = i.status_id
        WHERE i.organization_id = $1 AND i.project_id = $2
          AND i.created_at <= $3
        ORDER BY i.number`,
      [access.organizationId, access.projectId, asOf],
    ),
    getPool().query<{
      issue_id: string;
      event_type: "CREATED" | "TRANSITIONED";
      payload_json: Record<string, unknown>;
      created_at: Date;
      id: string;
    }>(
      `SELECT e.issue_id, e.event_type, e.payload_json, e.created_at, e.id
         FROM issue_events e JOIN issues i ON i.id = e.issue_id
        WHERE e.organization_id = $1 AND i.project_id = $2
          AND e.event_type IN ('CREATED', 'TRANSITIONED')
          AND e.created_at <= $3
        ORDER BY e.issue_id, e.created_at, e.id`,
      [access.organizationId, access.projectId, asOf],
    ),
  ]);
  const projectRow = project.rows[0];
  if (!projectRow) {
    throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);
  }
  const eventGroups = new Map<string, typeof events.rows>();
  for (const event of events.rows) {
    const group = eventGroups.get(event.issue_id) ?? [];
    group.push(event);
    eventGroups.set(event.issue_id, group);
  }
  const isCategory = (value: unknown): value is StatusCategory =>
    value === "TODO" || value === "IN_PROGRESS" || value === "DONE";
  const timelines: MetricIssueTimeline[] = issueRowsResult.rows.map((issue) => {
    const issueEvents = eventGroups.get(issue.id) ?? [];
    const createdEvent = issueEvents.find(
      (event) => event.event_type === "CREATED",
    );
    const initialCategory = createdEvent?.payload_json.initialStatusCategory;
    return {
      issueId: issue.id,
      issueKey: issue.issue_key,
      summary: issue.summary,
      createdAt: issue.created_at,
      initialCategory: isCategory(initialCategory) ? initialCategory : "TODO",
      currentCategory: issue.current_category,
      transitions: issueEvents.flatMap((event) => {
        if (event.event_type !== "TRANSITIONED") return [];
        const fromCategory = event.payload_json.fromStatusCategory;
        const toCategory = event.payload_json.toStatusCategory;
        return isCategory(fromCategory) && isCategory(toCategory)
          ? [{ at: event.created_at, fromCategory, toCategory }]
          : [];
      }),
    };
  });
  const metrics = timelines.map((timeline) => ({
    timeline,
    metrics: computeIssueFlowMetrics(timeline, asOf),
  }));
  const completed = metrics.filter(
    (item) =>
      item.metrics.firstDoneAt &&
      item.metrics.firstDoneAt >= from &&
      item.metrics.firstDoneAt <= asOf,
  );
  const dates = eachUtcDate(
    from,
    new Date(
      Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
    ),
  );
  const throughput = dates.map((date) => {
    const key = utcDate(date);
    return {
      date: key,
      count: completed.filter(
        (item) =>
          item.metrics.firstDoneAt && utcDate(item.metrics.firstDoneAt) === key,
      ).length,
    };
  });
  const createdResolved = dates.map((date) => {
    const key = utcDate(date);
    return {
      date: key,
      created: timelines.filter((issue) => utcDate(issue.createdAt) === key)
        .length,
      resolved: throughput.find((point) => point.date === key)?.count ?? 0,
    };
  });
  const cumulativeFlow = dates.map((date) => {
    const endOfDay = new Date(`${utcDate(date)}T23:59:59.999Z`);
    const instant = endOfDay > asOf ? asOf : endOfDay;
    const categories = timelines.map((issue) => categoryAt(issue, instant));
    return {
      date: utcDate(date),
      todo: categories.filter((category) => category === "TODO").length,
      inProgress: categories.filter((category) => category === "IN_PROGRESS")
        .length,
      done: categories.filter((category) => category === "DONE").length,
    };
  });
  const statusTime = (["TODO", "IN_PROGRESS", "DONE"] as const).map(
    (category) => ({
      category,
      averageSeconds:
        average(metrics.map((item) => item.metrics.statusSeconds[category])) ??
        0,
    }),
  );
  const agingWip = metrics
    .filter((item) => item.metrics.wipAgeSeconds !== null)
    .map((item) => ({
      issueId: item.timeline.issueId,
      issueKey: item.timeline.issueKey,
      summary: item.timeline.summary,
      ageSeconds: item.metrics.wipAgeSeconds!,
    }))
    .sort((left, right) => right.ageSeconds - left.ageSeconds);
  return {
    project: {
      id: projectRow.id,
      key: projectRow.project_key,
      name: projectRow.name,
      boardId: projectRow.board_id,
    },
    period: { from: utcDate(from), to: utcDate(asOf), timezone: "UTC" },
    summary: {
      throughput: completed.length,
      averageLeadTimeSeconds: average(
        completed.flatMap((item) =>
          item.metrics.leadTimeSeconds === null
            ? []
            : [item.metrics.leadTimeSeconds],
        ),
      ),
      averageCycleTimeSeconds: average(
        completed.flatMap((item) =>
          item.metrics.cycleTimeSeconds === null
            ? []
            : [item.metrics.cycleTimeSeconds],
        ),
      ),
      activeWip: agingWip.length,
      averageWipAgeSeconds: average(agingWip.map((item) => item.ageSeconds)),
    },
    throughput,
    createdResolved,
    cumulativeFlow,
    statusTime,
    agingWip,
  };
}

export async function getOutboxHealth(
  identity: UserIdentity,
): Promise<OutboxHealthView> {
  assertCapability(identity.organizationRole, null, "outbox:monitor");
  const [summary, topics, heartbeat, deadLetters] = await Promise.all([
    getPool().query<{
      pending: string;
      dead_lettered: string;
      oldest_pending_at: Date | null;
      delivered_last_hour: string;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE published_at IS NULL AND dead_lettered_at IS NULL
         ) AS pending,
         count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_lettered,
         min(created_at) FILTER (
           WHERE published_at IS NULL AND dead_lettered_at IS NULL
         ) AS oldest_pending_at,
         (SELECT count(*) FROM outbox_deliveries d
           WHERE d.organization_id = $1
             AND d.consumer = 'internal-ledger'
             AND d.delivered_at >= now() - interval '1 hour') AS delivered_last_hour
       FROM outbox_events
      WHERE organization_id = $1
        AND topic NOT IN ('notification.mention', 'notification.issue_commented')`,
      [identity.organizationId],
    ),
    getPool().query<{
      topic: string;
      pending: string;
      dead_lettered: string;
    }>(
      `SELECT topic,
              count(*) FILTER (
                WHERE published_at IS NULL AND dead_lettered_at IS NULL
              ) AS pending,
              count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead_lettered
         FROM outbox_events
        WHERE organization_id = $1
          AND topic NOT IN ('notification.mention', 'notification.issue_commented')
        GROUP BY topic
       HAVING count(*) FILTER (
                WHERE published_at IS NULL OR dead_lettered_at IS NOT NULL
              ) > 0
        ORDER BY topic`,
      [identity.organizationId],
    ),
    getPool().query<{
      instance_id: string;
      last_seen_at: Date;
      last_error: string | null;
      healthy: boolean;
    }>(
      `SELECT instance_id, last_seen_at, last_error,
              last_seen_at >= now() - interval '2 minutes'
                AND last_error IS NULL AS healthy
         FROM worker_heartbeats WHERE worker_name = 'outbox'`,
    ),
    getPool().query<{
      id: string;
      topic: string;
      aggregate_id: string;
      attempts: number;
      last_error: string | null;
      created_at: Date;
      dead_lettered_at: Date;
    }>(
      `SELECT id, topic, aggregate_id, attempts, last_error,
              created_at, dead_lettered_at
         FROM outbox_events
        WHERE organization_id = $1 AND dead_lettered_at IS NOT NULL
          AND topic NOT IN ('notification.mention', 'notification.issue_commented')
        ORDER BY dead_lettered_at DESC, id DESC
        LIMIT 50`,
      [identity.organizationId],
    ),
  ]);
  const totals = summary.rows[0];
  const worker = heartbeat.rows[0];
  return {
    worker: {
      state: worker ? (worker.healthy ? "HEALTHY" : "STALE") : "STARTING",
      instanceId: worker?.instance_id ?? null,
      lastSeenAt: worker?.last_seen_at.toISOString() ?? null,
      lastError: worker?.last_error ?? null,
    },
    pending: Number(totals?.pending ?? 0),
    deadLettered: Number(totals?.dead_lettered ?? 0),
    deliveredLastHour: Number(totals?.delivered_last_hour ?? 0),
    oldestPendingAt: totals?.oldest_pending_at?.toISOString() ?? null,
    topics: topics.rows.map((row) => ({
      topic: row.topic,
      pending: Number(row.pending),
      deadLettered: Number(row.dead_lettered),
    })),
    deadLetters: deadLetters.rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      aggregateId: row.aggregate_id,
      attempts: row.attempts,
      lastError: row.last_error ?? "Unknown delivery error",
      createdAt: row.created_at.toISOString(),
      deadLetteredAt: row.dead_lettered_at.toISOString(),
    })),
  };
}

export async function retryOutboxEvent(
  identity: UserIdentity,
  eventId: string,
  requestCorrelationId: string = randomUUID(),
): Promise<void> {
  assertCapability(identity.organizationRole, null, "outbox:monitor");
  await inTransaction(async (client) => {
    const retried = await client.query<{ topic: string }>(
      `UPDATE outbox_events
          SET attempts = 0, available_at = now(), last_error = NULL,
              dead_lettered_at = NULL
        WHERE id = $1 AND organization_id = $2
          AND published_at IS NULL AND dead_lettered_at IS NOT NULL
          AND topic NOT IN ('notification.mention', 'notification.issue_commented')
        RETURNING topic`,
      [eventId, identity.organizationId],
    );
    const event = retried.rows[0];
    if (!event) {
      throw new DomainError(
        "OUTBOX_EVENT_NOT_FOUND",
        "Dead-lettered outbox event not found",
        404,
      );
    }
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id)
       VALUES ($1, $2, $3, 'outbox.retried', 'outbox_event', $4, $5, $6)`,
      [
        randomUUID(),
        identity.organizationId,
        identity.id,
        eventId,
        JSON.stringify({ topic: event.topic }),
        requestCorrelationId,
      ],
    );
  });
}

export async function getNotificationPreferences(
  identity: UserIdentity,
): Promise<NotificationPreferences> {
  const result = await getPool().query<{
    event_class: NotificationEventClass;
    enabled: boolean;
  }>(
    `SELECT event_class, enabled
       FROM notification_preferences
      WHERE organization_id = $1 AND user_id = $2`,
    [identity.organizationId, identity.id],
  );
  const values = new Map(
    result.rows.map((row) => [row.event_class, row.enabled] as const),
  );
  return {
    mentions: values.get("MENTION") ?? true,
    issueComments: values.get("ISSUE_COMMENTED") ?? true,
  };
}

export async function setNotificationPreferences(
  identity: UserIdentity,
  preferences: NotificationPreferences,
  requestCorrelationId: string = randomUUID(),
): Promise<NotificationPreferences> {
  await inTransaction(async (client) => {
    for (const [eventClass, enabled] of [
      ["MENTION", preferences.mentions],
      ["ISSUE_COMMENTED", preferences.issueComments],
    ] as const) {
      await client.query(
        `INSERT INTO notification_preferences
          (organization_id, user_id, event_class, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, event_class) DO UPDATE
           SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [identity.organizationId, identity.id, eventClass, enabled],
      );
    }
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, metadata, correlation_id)
       VALUES ($1, $2, $3, 'notification.preferences_updated', 'user', $3, $4, $5)`,
      [
        randomUUID(),
        identity.organizationId,
        identity.id,
        JSON.stringify(preferences),
        requestCorrelationId,
      ],
    );
  });
  return preferences;
}

export async function listNotifications(
  identity: UserIdentity,
  options: PageOptions,
): Promise<NotificationCenterView> {
  const values: unknown[] = [identity.organizationId, identity.id];
  let cursorClause = "";
  if (options.cursor) {
    const [createdAt, id] = decodeCursor(options.cursor, "notifications");
    if (typeof createdAt !== "string" || typeof id !== "string") {
      throw new DomainError(
        "INVALID_CURSOR",
        "The pagination cursor is invalid or expired",
        400,
      );
    }
    values.push(createdAt, id);
    cursorClause = `AND (n.created_at, n.id) < ($3::timestamptz, $4::uuid)`;
  }
  values.push(options.limit + 1);
  const limitParameter = values.length;
  const notifications = await getPool().query<{
    id: string;
    event_class: NotificationEventClass;
    actor_id: string;
    actor_name: string;
    issue_id: string;
    issue_key: string;
    issue_summary: string;
    project_key: string;
    board_id: string;
    comment_id: string;
    read_at: Date | null;
    created_at: Date;
  }>(
    `SELECT n.id, n.event_class, n.actor_id,
            actor.display_name AS actor_name, i.id AS issue_id,
            p.project_key || '-' || i.number::text AS issue_key,
            i.summary AS issue_summary, p.project_key, b.id AS board_id,
            n.comment_id, n.read_at, n.created_at
       FROM notifications n
       JOIN users actor ON actor.id = n.actor_id
       JOIN issues i ON i.id = n.issue_id
       JOIN projects p ON p.id = i.project_id
       JOIN boards b ON b.project_id = p.id
      WHERE n.organization_id = $1 AND n.recipient_user_id = $2
        ${cursorClause}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $${limitParameter}`,
    values,
  );
  const hasMore = notifications.rows.length > options.limit;
  const rows = notifications.rows.slice(0, options.limit);
  const last = rows.at(-1);
  const unread = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM notifications
      WHERE organization_id = $1 AND recipient_user_id = $2 AND read_at IS NULL`,
    [identity.organizationId, identity.id],
  );
  return {
    items: rows.map((row): NotificationView => ({
      id: row.id,
      eventClass: row.event_class,
      actor: { id: row.actor_id, displayName: row.actor_name },
      issue: {
        id: row.issue_id,
        key: row.issue_key,
        summary: row.issue_summary,
        projectKey: row.project_key,
        boardId: row.board_id,
      },
      commentId: row.comment_id,
      readAt: row.read_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor("notifications", [
            last.created_at.toISOString(),
            last.id,
          ])
        : null,
    unreadCount: Number(unread.rows[0]?.count ?? 0),
    preferences: await getNotificationPreferences(identity),
  };
}

export async function markNotificationRead(
  identity: UserIdentity,
  notificationId: string,
): Promise<void> {
  const result = await getPool().query(
    `UPDATE notifications SET read_at = coalesce(read_at, now())
      WHERE id = $1 AND organization_id = $2 AND recipient_user_id = $3`,
    [notificationId, identity.organizationId, identity.id],
  );
  if (result.rowCount !== 1) {
    throw new DomainError(
      "NOTIFICATION_NOT_FOUND",
      "Notification not found",
      404,
    );
  }
}

export async function markAllNotificationsRead(
  identity: UserIdentity,
): Promise<number> {
  const result = await getPool().query(
    `UPDATE notifications SET read_at = now()
      WHERE organization_id = $1 AND recipient_user_id = $2 AND read_at IS NULL`,
    [identity.organizationId, identity.id],
  );
  return result.rowCount ?? 0;
}

interface RankedIssueRow extends QueryResultRow {
  id: string;
  rank: string;
}

async function lockProjectOrdering(
  client: PoolClient,
  projectId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [projectId],
  );
}

async function projectBoardColumnForStatus(
  client: PoolClient,
  access: ProjectAccess,
  statusId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT bc.id
       FROM board_columns bc
       JOIN boards b ON b.id = bc.board_id
       JOIN column_statuses cs ON cs.board_column_id = bc.id
      WHERE b.organization_id = $1 AND b.project_id = $2
        AND cs.status_id = $3
      ORDER BY bc.position, bc.id
      LIMIT 1`,
    [access.organizationId, access.projectId, statusId],
  );
  const columnId = result.rows[0]?.id;
  if (!columnId) {
    throw new DomainError(
      "PROJECT_CONFIGURATION",
      "The issue status is not mapped to a board column",
      500,
    );
  }
  return columnId;
}

async function lockColumnIssues(
  client: PoolClient,
  access: ProjectAccess,
  destinationColumnId: string,
): Promise<RankedIssueRow[]> {
  const result = await client.query<RankedIssueRow>(
    `SELECT i.id, i.rank::text
       FROM issues i
       JOIN column_statuses cs
         ON cs.status_id = i.status_id
        AND cs.organization_id = i.organization_id
      WHERE i.organization_id = $1 AND i.project_id = $2
        AND cs.board_column_id = $3 AND i.deleted_at IS NULL
      ORDER BY i.rank, i.id
      FOR UPDATE OF i`,
    [access.organizationId, access.projectId, destinationColumnId],
  );
  return result.rows;
}

function resolveRankNeighbors(
  rows: RankedIssueRow[],
  movingIssueId: string,
  beforeIssueId: string | null,
  afterIssueId: string | null,
): { beforeRank: string | null; afterRank: string | null } {
  const candidates = rows.filter((row) => row.id !== movingIssueId);
  const beforeIndex =
    beforeIssueId === null
      ? -1
      : candidates.findIndex((row) => row.id === beforeIssueId);
  const afterIndex =
    afterIssueId === null
      ? -1
      : candidates.findIndex((row) => row.id === afterIssueId);
  const valid =
    (beforeIssueId === null
      ? afterIssueId === null
        ? candidates.length === 0
        : afterIndex === 0
      : afterIssueId === null
        ? beforeIndex === candidates.length - 1
        : beforeIndex >= 0 && afterIndex === beforeIndex + 1) &&
    beforeIssueId !== movingIssueId &&
    afterIssueId !== movingIssueId;
  if (!valid) {
    throw new DomainError(
      "INVALID_RANK_NEIGHBORS",
      "The board order changed; refresh and try again",
      409,
    );
  }
  return {
    beforeRank: beforeIndex >= 0 ? candidates[beforeIndex]!.rank : null,
    afterRank: afterIndex >= 0 ? candidates[afterIndex]!.rank : null,
  };
}

async function fractionalRank(
  client: PoolClient,
  beforeRank: string | null,
  afterRank: string | null,
): Promise<{ rank: string; hasSpace: boolean }> {
  const result = await client.query<{ rank: string; has_space: boolean }>(
    `WITH candidate AS (
       SELECT CASE
         WHEN $1::numeric IS NULL AND $2::numeric IS NULL
           THEN round(1024::numeric, 10)
         WHEN $1::numeric IS NULL THEN round($2::numeric / 2, 10)
         WHEN $2::numeric IS NULL THEN round($1::numeric + 1024, 10)
         ELSE round(($1::numeric + $2::numeric) / 2, 10)
       END AS value
     )
     SELECT value::text AS rank,
            value > 0
            AND value <= 99999999999999999999.9999999999
            AND ($1::numeric IS NULL OR value > $1::numeric)
            AND ($2::numeric IS NULL OR value < $2::numeric) AS has_space
       FROM candidate`,
    [beforeRank, afterRank],
  );
  const row = result.rows[0]!;
  return { rank: row.rank, hasSpace: row.has_space };
}

async function rebalanceColumn(
  client: PoolClient,
  access: ProjectAccess,
  destinationColumnId: string,
  movingIssueId: string,
): Promise<void> {
  await client.query(
    `WITH ordered AS (
       SELECT i.id, row_number() OVER (ORDER BY i.rank, i.id) * 1024::numeric AS new_rank
         FROM issues i
         JOIN column_statuses cs
           ON cs.status_id = i.status_id
          AND cs.organization_id = i.organization_id
        WHERE i.organization_id = $1 AND i.project_id = $2
          AND cs.board_column_id = $3 AND i.deleted_at IS NULL
          AND i.id <> $4
     )
     UPDATE issues i SET rank = ordered.new_rank
       FROM ordered WHERE i.id = ordered.id`,
    [
      access.organizationId,
      access.projectId,
      destinationColumnId,
      movingIssueId,
    ],
  );
}

async function allocateColumnRank(
  client: PoolClient,
  access: ProjectAccess,
  destinationColumnId: string,
  movingIssueId: string,
  beforeIssueId: string | null,
  afterIssueId: string | null,
  lockedRows?: RankedIssueRow[],
): Promise<string> {
  let destinationRows =
    lockedRows ?? (await lockColumnIssues(client, access, destinationColumnId));
  let neighbors = resolveRankNeighbors(
    destinationRows,
    movingIssueId,
    beforeIssueId,
    afterIssueId,
  );
  let nextRank = await fractionalRank(
    client,
    neighbors.beforeRank,
    neighbors.afterRank,
  );
  if (!nextRank.hasSpace) {
    await rebalanceColumn(client, access, destinationColumnId, movingIssueId);
    destinationRows = await lockColumnIssues(
      client,
      access,
      destinationColumnId,
    );
    neighbors = resolveRankNeighbors(
      destinationRows,
      movingIssueId,
      beforeIssueId,
      afterIssueId,
    );
    nextRank = await fractionalRank(
      client,
      neighbors.beforeRank,
      neighbors.afterRank,
    );
    if (!nextRank.hasSpace) {
      throw new DomainError(
        "RANK_EXHAUSTED",
        "The destination order could not be allocated",
        409,
      );
    }
  }
  return nextRank.rank;
}

export async function transitionIssue(
  identity: UserIdentity,
  access: ProjectAccess,
  issueKey: string,
  input: {
    transitionId: string | null;
    destinationColumnId: string;
    destinationStatusId: string;
    beforeIssueId: string | null;
    afterIssueId: string | null;
    version: number;
  },
  requestCorrelationId: string = randomUUID(),
): Promise<IssueView> {
  const [projectKey, number] = splitIssueKey(issueKey);
  if (!projectKey || !number)
    throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
  let issueId = "";
  await inTransaction(async (client) => {
    await lockProjectOrdering(client, access.projectId);
    const locked = await client.query<{
      id: string;
      status_id: string;
      status_category: StatusCategory;
      version: number;
      workflow_id: string;
    }>(
      `SELECT i.id, i.status_id, current_status.category AS status_category,
              i.version, w.id AS workflow_id
         FROM issues i JOIN projects p ON p.id = i.project_id
         JOIN workflows w ON w.project_id = p.id AND w.active
         JOIN statuses current_status ON current_status.id = i.status_id
        WHERE i.organization_id = $1 AND i.project_id = $2
          AND p.project_key = $3 AND i.number = $4
          AND i.deleted_at IS NULL
        FOR UPDATE OF i`,
      [access.organizationId, access.projectId, projectKey, number],
    );
    const issue = locked.rows[0];
    if (!issue)
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    issueId = issue.id;
    assertVersion(input.version, issue.version);

    const destination = await client.query<{ category: StatusCategory }>(
      `SELECT destination_status.category
         FROM board_columns bc
         JOIN boards b ON b.id = bc.board_id
         JOIN column_statuses cs ON cs.board_column_id = bc.id
         JOIN statuses destination_status ON destination_status.id = cs.status_id
        WHERE b.organization_id = $1 AND b.project_id = $2
          AND bc.id = $3 AND cs.status_id = $4`,
      [
        access.organizationId,
        access.projectId,
        input.destinationColumnId,
        input.destinationStatusId,
      ],
    );
    const destinationStatus = destination.rows[0];
    if (!destinationStatus) {
      throw new DomainError(
        "INVALID_BOARD_DESTINATION",
        "The destination is not part of this project board",
        422,
      );
    }

    const reordered = issue.status_id === input.destinationStatusId;
    if (reordered) {
      if (input.transitionId !== null) {
        throw new DomainError(
          "INVALID_TRANSITION",
          "A workflow transition cannot be used for a reorder",
          422,
        );
      }
    } else {
      const transitionResult = await client.query<{
        from_status_id: string;
        to_status_id: string;
      }>(
        `SELECT from_status_id, to_status_id FROM transitions
          WHERE id = $1 AND workflow_id = $2`,
        [input.transitionId, issue.workflow_id],
      );
      const transition = transitionResult.rows[0];
      assertTransition(
        transition
          ? {
              fromStatusId: transition.from_status_id,
              toStatusId: transition.to_status_id,
            }
          : null,
        issue.status_id,
        input.destinationStatusId,
      );
    }

    const nextRank = await allocateColumnRank(
      client,
      access,
      input.destinationColumnId,
      issue.id,
      input.beforeIssueId,
      input.afterIssueId,
    );

    const updated = await client.query(
      `UPDATE issues SET status_id = $1, rank = $2::numeric(30, 10),
                         version = version + 1, updated_at = now()
        WHERE id = $3 AND version = $4`,
      [input.destinationStatusId, nextRank, issue.id, input.version],
    );
    if (updated.rowCount !== 1) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "This issue changed since it was loaded",
        409,
      );
    }
    const eventType = reordered ? "REORDERED" : "TRANSITIONED";
    const action = reordered ? "issue.reordered" : "issue.transitioned";
    const payload = {
      fromStatusId: issue.status_id,
      toStatusId: input.destinationStatusId,
      fromStatusCategory: issue.status_category,
      toStatusCategory: destinationStatus.category,
      destinationColumnId: input.destinationColumnId,
      beforeIssueId: input.beforeIssueId,
      afterIssueId: input.afterIssueId,
      rank: nextRank,
      fromVersion: issue.version,
      toVersion: issue.version + 1,
    };
    await client.query(
      `INSERT INTO issue_events
        (id, organization_id, issue_id, actor_id, event_type, payload_json, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        access.organizationId,
        issue.id,
        identity.id,
        eventType,
        JSON.stringify(payload),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, metadata, correlation_id)
       VALUES ($1, $2, $3, $4, 'issue', $5, $6, $7)`,
      [
        randomUUID(),
        access.organizationId,
        identity.id,
        action,
        issue.id,
        JSON.stringify(payload),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        access.organizationId,
        action,
        issue.id,
        JSON.stringify({ ...payload, correlationId: requestCorrelationId }),
      ],
    );
  });
  const updatedIssue = await getIssueById(issueId, access.organizationId);
  if (!updatedIssue)
    throw new DomainError(
      "ISSUE_NOT_FOUND",
      "Issue not found after transition",
      500,
    );
  return updatedIssue;
}

export async function updateIssue(
  identity: UserIdentity,
  access: ProjectAccess,
  issueKey: string,
  input: {
    summary: string;
    description: string;
    priority: Priority;
    issueType: IssueType;
    assigneeId: string | null;
    labels: string[];
    parentIssueKey: string | null;
    estimatePoints?: number | null;
    dueDate?: string | null;
    version: number;
  },
  requestCorrelationId: string = randomUUID(),
): Promise<IssueDetailView> {
  const [projectKey, number] = splitIssueKey(issueKey);
  if (!projectKey || !number)
    throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);

  await inTransaction(async (client) => {
    const locked = await client.query<{
      id: string;
      summary: string;
      description: string | null;
      priority: Priority;
      issue_type_id: string;
      assignee_id: string | null;
      parent_id: string | null;
      estimate_points: number | null;
      due_date: string | null;
      version: number;
    }>(
      `SELECT i.id, i.summary, i.description, i.priority, i.issue_type_id,
              i.assignee_id, i.parent_id, i.estimate_points,
              i.due_date::text, i.version
         FROM issues i
         JOIN projects p ON p.id = i.project_id
        WHERE i.organization_id = $1 AND i.project_id = $2
          AND p.project_key = $3 AND i.number = $4 AND i.deleted_at IS NULL
        FOR UPDATE OF i`,
      [access.organizationId, access.projectId, projectKey, number],
    );
    const issue = locked.rows[0];
    if (!issue)
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    assertVersion(input.version, issue.version);

    await assertAssignableUser(client, access, input.assigneeId);
    const issueType = await resolveIssueType(client, access, input.issueType);
    const parent = await resolveParentIssue(
      client,
      access,
      input.parentIssueKey,
      issueType.hierarchyLevel,
      issue.id,
    );
    if (issue.issue_type_id !== issueType.id) {
      await assertExistingChildrenCompatible(
        client,
        access,
        issue.id,
        issueType.hierarchyLevel,
      );
    }
    const currentLabels = normalizeLabels(
      await getIssueLabels(client, access.organizationId, issue.id),
    );
    const labels = normalizeLabels(input.labels);
    const estimatePoints =
      input.estimatePoints === undefined
        ? issue.estimate_points
        : input.estimatePoints;
    const dueDate =
      input.dueDate === undefined ? issue.due_date : input.dueDate;
    const labelsChanged =
      currentLabels.map((label) => label.normalizedName).join("\0") !==
      labels.map((label) => label.normalizedName).join("\0");

    const changedFields: string[] = [];
    if (issue.summary !== input.summary) changedFields.push("summary");
    if ((issue.description ?? "") !== input.description)
      changedFields.push("description");
    if (issue.priority !== input.priority) changedFields.push("priority");
    if (issue.issue_type_id !== issueType.id) changedFields.push("issueType");
    if (issue.assignee_id !== input.assigneeId) changedFields.push("assignee");
    if (issue.parent_id !== (parent?.id ?? null)) changedFields.push("parent");
    if (labelsChanged) changedFields.push("labels");
    if (issue.estimate_points !== estimatePoints)
      changedFields.push("estimatePoints");
    if (issue.due_date !== dueDate) changedFields.push("dueDate");
    if (changedFields.length === 0) return;

    const updated = await client.query(
      `UPDATE issues
          SET summary = $1, description = $2, priority = $3, issue_type_id = $4,
              assignee_id = $5, parent_id = $6, estimate_points = $7,
              due_date = $8,
              version = version + 1, updated_at = now()
        WHERE id = $9 AND organization_id = $10 AND version = $11`,
      [
        input.summary,
        input.description,
        input.priority,
        issueType.id,
        input.assigneeId,
        parent?.id ?? null,
        estimatePoints,
        dueDate,
        issue.id,
        access.organizationId,
        input.version,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "This issue changed since it was loaded. Refresh and try again.",
        409,
      );
    }
    if (labelsChanged) {
      await replaceIssueLabels(client, access.organizationId, issue.id, labels);
    }

    const payload = {
      fields: changedFields,
      fromVersion: issue.version,
      toVersion: issue.version + 1,
    };
    await client.query(
      `INSERT INTO issue_events
        (id, organization_id, issue_id, actor_id, event_type, payload_json, correlation_id)
       VALUES ($1, $2, $3, $4, 'UPDATED', $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        issue.id,
        identity.id,
        JSON.stringify(payload),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id, metadata, correlation_id)
       VALUES ($1, $2, $3, 'issue.updated', 'issue', $4, $5, $6)`,
      [
        randomUUID(),
        access.organizationId,
        identity.id,
        issue.id,
        JSON.stringify({ fields: changedFields }),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'issue.updated', $3, $4)`,
      [
        randomUUID(),
        access.organizationId,
        issue.id,
        JSON.stringify({ ...payload, correlationId: requestCorrelationId }),
      ],
    );
  });

  const updatedIssue = await getIssueDetail(issueKey, access);
  if (!updatedIssue)
    throw new DomainError(
      "ISSUE_NOT_FOUND",
      "Issue not found after update",
      500,
    );
  return updatedIssue;
}

async function writeIssueLifecycleChange(
  client: PoolClient,
  identity: UserIdentity,
  access: ProjectAccess,
  issueId: string,
  eventType: "DELETED" | "RESTORED",
  fromVersion: number,
  requestCorrelationId: string,
): Promise<void> {
  const action = eventType === "DELETED" ? "issue.deleted" : "issue.restored";
  const payload = {
    fromVersion,
    toVersion: fromVersion + 1,
  };
  await client.query(
    `INSERT INTO issue_events
      (id, organization_id, issue_id, actor_id, event_type, payload_json, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      access.organizationId,
      issueId,
      identity.id,
      eventType,
      JSON.stringify(payload),
      requestCorrelationId,
    ],
  );
  await client.query(
    `INSERT INTO audit_events
      (id, organization_id, actor_id, action, target_type, target_id, metadata, correlation_id)
     VALUES ($1, $2, $3, $4, 'issue', $5, $6, $7)`,
    [
      randomUUID(),
      access.organizationId,
      identity.id,
      action,
      issueId,
      JSON.stringify(payload),
      requestCorrelationId,
    ],
  );
  await client.query(
    `INSERT INTO outbox_events
      (id, organization_id, topic, aggregate_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomUUID(),
      access.organizationId,
      action,
      issueId,
      JSON.stringify({
        issueId,
        projectId: access.projectId,
        ...payload,
        correlationId: requestCorrelationId,
      }),
    ],
  );
}

export async function deleteIssue(
  identity: UserIdentity,
  access: ProjectAccess,
  issueKey: string,
  expectedVersion: number,
  requestCorrelationId: string = randomUUID(),
): Promise<void> {
  const [projectKey, number] = splitIssueKey(issueKey);
  if (!projectKey || !number) {
    throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
  }
  await inTransaction(async (client) => {
    await lockProjectOrdering(client, access.projectId);
    const locked = await client.query<{ id: string; version: number }>(
      `SELECT i.id, i.version
         FROM issues i
         JOIN projects p ON p.id = i.project_id
        WHERE i.organization_id = $1 AND i.project_id = $2
          AND p.project_key = $3 AND i.number = $4 AND i.deleted_at IS NULL
        FOR UPDATE OF i`,
      [access.organizationId, access.projectId, projectKey, number],
    );
    const issue = locked.rows[0];
    if (!issue) {
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    }
    assertVersion(expectedVersion, issue.version);
    const activeChild = await client.query<{ id: string }>(
      `SELECT id FROM issues
        WHERE organization_id = $1 AND project_id = $2
          AND parent_id = $3 AND deleted_at IS NULL
        LIMIT 1
        FOR SHARE`,
      [access.organizationId, access.projectId, issue.id],
    );
    if (activeChild.rows[0]) {
      throw new DomainError(
        "ISSUE_HAS_ACTIVE_CHILDREN",
        "Delete or move this issue's active children before deleting it",
        409,
      );
    }
    const updated = await client.query(
      `UPDATE issues
          SET deleted_at = now(), deleted_by = $1,
              version = version + 1, updated_at = now()
        WHERE id = $2 AND organization_id = $3
          AND version = $4 AND deleted_at IS NULL`,
      [identity.id, issue.id, access.organizationId, expectedVersion],
    );
    if (updated.rowCount !== 1) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "This issue changed since it was loaded. Refresh and try again.",
        409,
      );
    }
    await writeIssueLifecycleChange(
      client,
      identity,
      access,
      issue.id,
      "DELETED",
      issue.version,
      requestCorrelationId,
    );
  });
}

export async function restoreIssue(
  identity: UserIdentity,
  access: ProjectAccess,
  issueKey: string,
  expectedVersion: number,
  requestCorrelationId: string = randomUUID(),
): Promise<IssueDetailView> {
  const [projectKey, number] = splitIssueKey(issueKey);
  if (!projectKey || !number) {
    throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
  }
  await inTransaction(async (client) => {
    await lockProjectOrdering(client, access.projectId);
    const locked = await client.query<{
      id: string;
      status_id: string;
      version: number;
      parent_id: string | null;
      assignee_id: string | null;
      hierarchy_level: IssueHierarchyLevel;
    }>(
      `SELECT i.id, i.status_id, i.version, i.parent_id, i.assignee_id, it.hierarchy_level
         FROM issues i
         JOIN projects p ON p.id = i.project_id
         JOIN issue_types it ON it.id = i.issue_type_id
        WHERE i.organization_id = $1 AND i.project_id = $2
          AND p.project_key = $3 AND i.number = $4 AND i.deleted_at IS NOT NULL
        FOR UPDATE OF i`,
      [access.organizationId, access.projectId, projectKey, number],
    );
    const issue = locked.rows[0];
    if (!issue) {
      throw new DomainError(
        "DELETED_ISSUE_NOT_FOUND",
        "Deleted issue not found",
        404,
      );
    }
    assertVersion(expectedVersion, issue.version);
    if (issue.parent_id) {
      const activeParent = await client.query<{
        id: string;
        hierarchy_level: IssueHierarchyLevel;
      }>(
        `SELECT parent.id, parent_type.hierarchy_level
           FROM issues parent
           JOIN issue_types parent_type ON parent_type.id = parent.issue_type_id
          WHERE parent.id = $1 AND parent.organization_id = $2
            AND parent.project_id = $3 AND parent.deleted_at IS NULL
          FOR SHARE OF parent`,
        [issue.parent_id, access.organizationId, access.projectId],
      );
      const parent = activeParent.rows[0];
      if (!parent) {
        throw new DomainError(
          "RESTORE_PARENT_NOT_ACTIVE",
          "Restore this issue's parent before restoring the issue",
          409,
        );
      }
      assertIssueParent(issue.hierarchy_level, parent.hierarchy_level);
    }
    await assertAssignableUser(client, access, issue.assignee_id);
    const destinationColumnId = await projectBoardColumnForStatus(
      client,
      access,
      issue.status_id,
    );
    const columnIssues = await lockColumnIssues(
      client,
      access,
      destinationColumnId,
    );
    const rank = await allocateColumnRank(
      client,
      access,
      destinationColumnId,
      issue.id,
      columnIssues.at(-1)?.id ?? null,
      null,
      columnIssues,
    );
    const updated = await client.query(
      `UPDATE issues
          SET deleted_at = NULL, deleted_by = NULL, rank = $1::numeric(30, 10),
              version = version + 1, updated_at = now()
        WHERE id = $2 AND organization_id = $3
          AND version = $4 AND deleted_at IS NOT NULL`,
      [rank, issue.id, access.organizationId, expectedVersion],
    );
    if (updated.rowCount !== 1) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "This issue changed since it was loaded. Refresh and try again.",
        409,
      );
    }
    await writeIssueLifecycleChange(
      client,
      identity,
      access,
      issue.id,
      "RESTORED",
      issue.version,
      requestCorrelationId,
    );
  });
  const restored = await getIssueDetail(issueKey, access);
  if (!restored) {
    throw new DomainError(
      "ISSUE_NOT_FOUND",
      "Issue not found after restoration",
      500,
    );
  }
  return restored;
}

export async function databaseReady(): Promise<boolean> {
  try {
    await getPool().query("SELECT 1 FROM schema_migrations LIMIT 1");
    return true;
  } catch {
    return false;
  }
}

function splitIssueKey(issueKey: string): [string | null, number | null] {
  const match = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/.exec(issueKey.toUpperCase());
  return match ? [match[1] ?? null, Number(match[2])] : [null, null];
}
