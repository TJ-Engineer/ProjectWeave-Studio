import { randomUUID } from "node:crypto";
import type {
  BoardColumnView,
  BoardView,
  IssueDetailView,
  IssueEventView,
  IssueView,
  Priority,
  ProjectMemberView,
  StatusView,
  TransitionView,
  UserIdentity,
} from "@vibe/contracts";
import {
  assertTransition,
  assertVersion,
  DomainError,
  type OrganizationRole,
  type ProjectRole,
} from "@vibe/domain";
import type { PoolClient, QueryResultRow } from "pg";
import { getPool, inTransaction } from "./client";

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
  issue_key: string;
  summary: string;
  description: string | null;
  priority: Priority;
  issue_type: string;
  status_id: string;
  rank: string;
  version: number;
  reporter_id: string;
  reporter_name: string;
  assignee_id: string | null;
  assignee_name: string | null;
  updated_at: Date;
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

export async function listProjects(
  identity: UserIdentity,
): Promise<Array<{ id: string; key: string; name: string; boardId: string }>> {
  const result = await getPool().query<{
    id: string;
    project_key: string;
    name: string;
    board_id: string;
  }>(
    `SELECT p.id, p.project_key, p.name, b.id AS board_id
       FROM projects p
       JOIN boards b ON b.project_id = p.id
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
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

export async function getProjectAccess(
  userId: string,
  projectKey: string,
): Promise<ProjectAccess | null> {
  const result = await getPool().query<AccessRow>(
    `SELECT p.organization_id, m.organization_role, p.id AS project_id,
            p.project_key, pm.role AS project_role
       FROM projects p
       JOIN memberships m ON m.organization_id = p.organization_id AND m.user_id = $1
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
      WHERE p.project_key = $2 AND p.archived_at IS NULL
      LIMIT 1`,
    [userId, projectKey],
  );
  return result.rows[0] ? toAccess(result.rows[0]) : null;
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
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
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
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
      WHERE p.project_key = $2 AND i.number = $3 AND i.deleted_at IS NULL
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
  input: { key: string; name: string },
  requestCorrelationId: string = randomUUID(),
): Promise<{ id: string; key: string; name: string; boardId: string }> {
  return inTransaction(async (client) => {
    const projectId = randomUUID();
    const workflowId = randomUUID();
    const boardId = randomUUID();
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
    for (const status of defaultStatuses) {
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
          status.position,
        ],
      );
    }

    const transitions = [
      ["backlog", "selected"],
      ["backlog", "inProgress"],
      ["selected", "backlog"],
      ["selected", "inProgress"],
      ["inProgress", "selected"],
      ["inProgress", "review"],
      ["review", "inProgress"],
      ["review", "done"],
      ["done", "review"],
    ] as const;
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
    const columnDefinitions = [
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
        (id, organization_id, actor_id, action, target_type, target_id, correlation_id)
       VALUES ($1, $2, $3, 'project.created', 'project', $4, $5)`,
      [
        randomUUID(),
        identity.organizationId,
        identity.id,
        projectId,
        requestCorrelationId,
      ],
    );
    return { id: projectId, key: input.key, name: input.name, boardId };
  });
}

export async function createIssue(
  identity: UserIdentity,
  access: ProjectAccess,
  input: {
    summary: string;
    description: string;
    priority: Priority;
    issueType: string;
  },
  requestCorrelationId: string = randomUUID(),
): Promise<IssueView> {
  const issueId = randomUUID();
  await inTransaction(async (client) => {
    const project = await client.query<{ sequence_counter: number }>(
      `UPDATE projects SET sequence_counter = sequence_counter + 1
        WHERE id = $1 AND organization_id = $2
        RETURNING sequence_counter`,
      [access.projectId, identity.organizationId],
    );
    const number = project.rows[0]?.sequence_counter;
    if (!number)
      throw new DomainError("PROJECT_NOT_FOUND", "Project not found", 404);

    const metadata = await client.query<{
      issue_type_id: string;
      status_id: string;
    }>(
      `SELECT it.id AS issue_type_id, s.id AS status_id
         FROM issue_types it
         CROSS JOIN statuses s
         JOIN workflows w ON w.id = s.workflow_id
        WHERE it.project_id = $1 AND upper(it.name) = $2
          AND w.project_id = $1 AND w.active AND s.name = 'Backlog'`,
      [access.projectId, input.issueType],
    );
    const ids = metadata.rows[0];
    if (!ids)
      throw new DomainError(
        "PROJECT_CONFIGURATION",
        "Project workflow is incomplete",
        500,
      );

    const rankResult = await client.query<{ next_rank: string }>(
      `SELECT COALESCE(MAX(rank), 0) + 1024 AS next_rank
         FROM issues WHERE project_id = $1 AND status_id = $2 AND deleted_at IS NULL`,
      [access.projectId, ids.status_id],
    );
    const rank = rankResult.rows[0]?.next_rank ?? "1024";
    await client.query(
      `INSERT INTO issues
        (id, organization_id, project_id, number, issue_type_id, status_id,
         summary, description, priority, reporter_id, rank)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        issueId,
        identity.organizationId,
        access.projectId,
        number,
        ids.issue_type_id,
        ids.status_id,
        input.summary,
        input.description,
        input.priority,
        identity.id,
        rank,
      ],
    );
    await client.query(
      `INSERT INTO issue_events
        (id, organization_id, issue_id, actor_id, event_type, payload_json, correlation_id)
       VALUES ($1, $2, $3, $4, 'CREATED', $5, $6)`,
      [
        randomUUID(),
        identity.organizationId,
        issueId,
        identity.id,
        JSON.stringify({ summary: input.summary, statusId: ids.status_id }),
        requestCorrelationId,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'issue.created', $3, $4)`,
      [
        randomUUID(),
        identity.organizationId,
        issueId,
        JSON.stringify({
          issueId,
          projectId: access.projectId,
          correlationId: requestCorrelationId,
        }),
      ],
    );
  });
  const issue = await getIssueById(issueId, identity.organizationId);
  if (!issue)
    throw new DomainError(
      "ISSUE_NOT_FOUND",
      "Issue not found after creation",
      500,
    );
  return issue;
}

async function issueRows(
  client: Pick<PoolClient, "query">,
  organizationId: string,
  whereSql: string,
  values: unknown[],
): Promise<IssueRow[]> {
  const result = await client.query<IssueRow>(
    `SELECT i.id, p.project_key || '-' || i.number AS issue_key, i.summary,
            i.description, i.priority, it.name AS issue_type, i.status_id,
            i.rank::text, i.version, reporter.id AS reporter_id,
            reporter.display_name AS reporter_name, assignee.id AS assignee_id,
            assignee.display_name AS assignee_name, i.updated_at
       FROM issues i
       JOIN projects p ON p.id = i.project_id
       JOIN issue_types it ON it.id = i.issue_type_id
       JOIN users reporter ON reporter.id = i.reporter_id
       LEFT JOIN users assignee ON assignee.id = i.assignee_id
      WHERE i.organization_id = $1 AND i.deleted_at IS NULL AND ${whereSql}
      ORDER BY i.rank, i.id`,
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
    rank: Number(row.rank),
    version: row.version,
    reporter: { id: row.reporter_id, displayName: row.reporter_name },
    assignee:
      row.assignee_id && row.assignee_name
        ? { id: row.assignee_id, displayName: row.assignee_name }
        : null,
    updatedAt: row.updated_at.toISOString(),
    allowedTransitions: transitions.filter(
      (item) => item.fromStatusId === row.status_id,
    ),
  };
}

async function getIssueById(
  id: string,
  organizationId: string,
): Promise<IssueView | null> {
  const rows = await issueRows(getPool(), organizationId, "i.id = $2", [id]);
  const row = rows[0];
  if (!row) return null;
  const project = await getPool().query<{ project_id: string }>(
    "SELECT project_id FROM issues WHERE id = $1 AND organization_id = $2",
    [id, organizationId],
  );
  const transitions = await transitionsForWorkflow(
    getPool(),
    project.rows[0]!.project_id,
  );
  return toIssue(row, transitions);
}

export async function getBoard(
  boardId: string,
  access: ProjectAccess,
): Promise<BoardView | null> {
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

  const columnResult = await pool.query<{
    id: string;
    name: string;
    position: number;
    wip_limit: number | null;
    status_id: string;
  }>(
    `SELECT bc.id, bc.name, bc.position, bc.wip_limit, cs.status_id
       FROM board_columns bc
       JOIN column_statuses cs ON cs.board_column_id = bc.id
      WHERE bc.board_id = $1 ORDER BY bc.position, cs.status_id`,
    [boardId],
  );
  const columnsById = new Map<string, BoardColumnView>();
  for (const row of columnResult.rows) {
    const column = columnsById.get(row.id) ?? {
      id: row.id,
      name: row.name,
      position: row.position,
      wipLimit: row.wip_limit,
      statusIds: [],
    };
    column.statusIds.push(row.status_id);
    columnsById.set(row.id, column);
  }

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
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1 AND pm.organization_id = $2
        AND u.organization_id = $2 AND u.state = 'ACTIVE'
      ORDER BY u.display_name, u.id`,
    [board.project_id, access.organizationId],
  );
  const rows = await issueRows(
    pool,
    access.organizationId,
    "i.project_id = $2",
    [board.project_id],
  );
  const transitions = await transitionsForWorkflow(pool, board.project_id);
  return {
    id: board.id,
    name: board.name,
    project: {
      id: board.project_id,
      key: board.project_key,
      name: board.project_name,
    },
    columns: [...columnsById.values()].sort((a, b) => a.position - b.position),
    statuses: statusResult.rows,
    members: memberResult.rows.map((row): ProjectMemberView => ({
      id: row.id,
      displayName: row.display_name,
    })),
    issues: rows.map((row) => toIssue(row, transitions)),
  };
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

export async function transitionIssue(
  identity: UserIdentity,
  access: ProjectAccess,
  issueKey: string,
  input: {
    transitionId: string;
    destinationStatusId: string;
    destinationRank: number;
    version: number;
  },
  requestCorrelationId: string = randomUUID(),
): Promise<IssueView> {
  const [projectKey, number] = splitIssueKey(issueKey);
  if (!projectKey || !number)
    throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
  let issueId = "";
  await inTransaction(async (client) => {
    const locked = await client.query<{
      id: string;
      status_id: string;
      version: number;
      workflow_id: string;
    }>(
      `SELECT i.id, i.status_id, i.version, w.id AS workflow_id
         FROM issues i JOIN projects p ON p.id = i.project_id
         JOIN workflows w ON w.project_id = p.id AND w.active
        WHERE i.organization_id = $1 AND p.project_key = $2 AND i.number = $3
          AND i.deleted_at IS NULL
        FOR UPDATE OF i`,
      [access.organizationId, projectKey, number],
    );
    const issue = locked.rows[0];
    if (!issue)
      throw new DomainError("ISSUE_NOT_FOUND", "Issue not found", 404);
    issueId = issue.id;
    assertVersion(input.version, issue.version);
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
    const updated = await client.query(
      `UPDATE issues SET status_id = $1, rank = $2, version = version + 1, updated_at = now()
        WHERE id = $3 AND version = $4`,
      [
        input.destinationStatusId,
        input.destinationRank,
        issue.id,
        input.version,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "This issue changed since it was loaded",
        409,
      );
    }
    const payload = {
      fromStatusId: issue.status_id,
      toStatusId: input.destinationStatusId,
      fromVersion: issue.version,
      toVersion: issue.version + 1,
    };
    await client.query(
      `INSERT INTO issue_events
        (id, organization_id, issue_id, actor_id, event_type, payload_json, correlation_id)
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
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'issue.transitioned', $3, $4)`,
      [
        randomUUID(),
        access.organizationId,
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
    assigneeId: string | null;
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
      assignee_id: string | null;
      version: number;
    }>(
      `SELECT i.id, i.summary, i.description, i.priority, i.assignee_id, i.version
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

    if (input.assigneeId) {
      const assignee = await client.query<{ id: string }>(
        `SELECT u.id
           FROM project_members pm
           JOIN users u ON u.id = pm.user_id
          WHERE pm.organization_id = $1 AND pm.project_id = $2
            AND pm.user_id = $3 AND u.organization_id = $1
            AND u.state = 'ACTIVE'`,
        [access.organizationId, access.projectId, input.assigneeId],
      );
      if (!assignee.rows[0]) {
        throw new DomainError(
          "INVALID_ASSIGNEE",
          "Assignee must be an active member of this project",
          422,
        );
      }
    }

    const changedFields: string[] = [];
    if (issue.summary !== input.summary) changedFields.push("summary");
    if ((issue.description ?? "") !== input.description)
      changedFields.push("description");
    if (issue.priority !== input.priority) changedFields.push("priority");
    if (issue.assignee_id !== input.assigneeId) changedFields.push("assignee");
    if (changedFields.length === 0) return;

    const updated = await client.query(
      `UPDATE issues
          SET summary = $1, description = $2, priority = $3, assignee_id = $4,
              version = version + 1, updated_at = now()
        WHERE id = $5 AND organization_id = $6 AND version = $7`,
      [
        input.summary,
        input.description,
        input.priority,
        input.assigneeId,
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
