import { randomUUID } from "node:crypto";
import type {
  BoardChangeEvent,
  IssueSearchQuery,
  UpdateWorkflowConfigurationInput,
} from "@vibe/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertCapability, DomainError } from "@vibe/domain";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)("atomic issue writes", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const { getPool } = await import("@vibe/database");
    const database = await getPool().query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    if (!database.rows[0]?.name.endsWith("_test")) {
      throw new Error(
        "Integration tests require a database whose name ends in _test",
      );
    }
    await getPool().query(`
      TRUNCATE worker_heartbeats, outbox_deliveries, idempotency_records, outbox_events, audit_events, issue_events, issue_labels, labels, issues, column_statuses,
        board_columns, boards, transitions, statuses, workflows, issue_types,
        project_members, projects, memberships, users, organizations CASCADE
    `);
  });

  afterAll(async () => {
    const { closePool } = await import("@vibe/database");
    await closePool();
  });

  it("commits one event and rejects a concurrent stale writer", async () => {
    const {
      createIssue,
      createProject,
      getBoard,
      getBoardAccess,
      getPool,
      transitionIssue,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const userId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Test', $2)`,
      [organizationId, `test-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Test Admin', 'unused')`,
      [userId, organizationId, `${userId}@example.test`],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')`,
      [organizationId, userId],
    );
    const identity = {
      id: userId,
      organizationId,
      email: `${userId}@example.test`,
      displayName: "Test Admin",
      organizationRole: "ADMIN" as const,
    };
    const project = await createProject(identity, { key: "TST", name: "Test" });
    const access = await getBoardAccess(userId, project.boardId);
    expect(access).not.toBeNull();
    const issue = await createIssue(identity, access!, {
      summary: "Concurrent transition",
      description: "",
      priority: "MEDIUM",
      issueType: "TASK",
    });
    const board = await getBoard(project.boardId, access!);
    const inProgress = board!.columns.find(
      (column) => column.name === "In Progress",
    )!;
    const transition = issue.allowedTransitions.find((item) =>
      inProgress.statusIds.includes(item.toStatusId),
    )!;
    const input = {
      transitionId: transition.id,
      destinationColumnId: inProgress.id,
      destinationStatusId: transition.toStatusId,
      beforeIssueId: null,
      afterIssueId: null,
      version: issue.version,
    };
    const results = await Promise.allSettled([
      transitionIssue(identity, access!, issue.key, input),
      transitionIssue(identity, access!, issue.key, input),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining<Partial<DomainError>>({
        code: "VERSION_CONFLICT",
      }),
    });
    const events = await getPool().query<{ event_type: string }>(
      "SELECT event_type FROM issue_events WHERE issue_id = $1 ORDER BY created_at",
      [issue.id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "CREATED",
      "TRANSITIONED",
    ]);
  });

  it("derives exact neighbor ranks and rebalances after repeated insertions", async () => {
    const {
      createIssue,
      createProject,
      getBoard,
      getBoardAccess,
      getPool,
      transitionIssue,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const userId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Rank Test', $2)`,
      [organizationId, `rank-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Rank Admin', 'unused')`,
      [userId, organizationId, `${userId}@example.test`],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')`,
      [organizationId, userId],
    );
    const identity = {
      id: userId,
      organizationId,
      email: `${userId}@example.test`,
      displayName: "Rank Admin",
      organizationRole: "ADMIN" as const,
    };
    const project = await createProject(identity, {
      key: "RANK",
      name: "Rank Test",
    });
    const access = await getBoardAccess(userId, project.boardId);
    expect(access).not.toBeNull();
    const initialBoard = await getBoard(project.boardId, access!);
    const todo = initialBoard!.columns.find(
      (column) => column.name === "To Do",
    )!;

    const issues = [];
    for (let index = 0; index < 50; index += 1) {
      issues.push(
        await createIssue(identity, access!, {
          summary: `Ranked issue ${index + 1}`,
          description: "",
          priority: "MEDIUM",
          issueType: "TASK",
        }),
      );
    }
    const anchor = issues[0]!;
    let after = issues[1]!;
    for (const issue of issues.slice(2)) {
      const moved = await transitionIssue(identity, access!, issue.key, {
        transitionId: null,
        destinationColumnId: todo.id,
        destinationStatusId: issue.statusId,
        beforeIssueId: anchor.id,
        afterIssueId: after.id,
        version: issue.version,
      });
      expect(moved.rank).toMatch(/^\d+\.\d{10}$/);
      after = moved;
    }

    const ordered = await getPool().query<{ id: string; rank: string }>(
      `SELECT id, rank::text
         FROM issues i
        WHERE i.project_id = $1 AND i.deleted_at IS NULL
        ORDER BY i.rank, i.id`,
      [project.id],
    );
    expect(ordered.rows).toHaveLength(50);
    expect(ordered.rows[0]?.id).toBe(anchor.id);
    expect(ordered.rows[1]?.id).toBe(issues.at(-1)?.id);
    expect(new Set(ordered.rows.map((row) => row.rank)).size).toBe(50);
    expect(ordered.rows.every((row) => /^\d+\.\d{10}$/.test(row.rank))).toBe(
      true,
    );

    const selectedStatus = initialBoard!.statuses.find(
      (status) => status.name === "Selected",
    )!;
    const selectTransition = issues[1]!.allowedTransitions.find(
      (transition) => transition.toStatusId === selectedStatus.id,
    )!;
    const selected = await transitionIssue(identity, access!, issues[1]!.key, {
      transitionId: selectTransition.id,
      destinationColumnId: todo.id,
      destinationStatusId: selectedStatus.id,
      beforeIssueId: issues[2]!.id,
      afterIssueId: null,
      version: issues[1]!.version,
    });
    const createdAfterTransition = await createIssue(identity, access!, {
      summary: "Created after an in-column status transition",
      description: "",
      priority: "MEDIUM",
      issueType: "TASK",
    });
    const columnTail = await getPool().query<{ id: string; rank: string }>(
      `SELECT id, rank::text
         FROM issues i
         JOIN column_statuses cs ON cs.status_id = i.status_id
        WHERE i.project_id = $1 AND cs.board_column_id = $2
          AND i.deleted_at IS NULL
        ORDER BY i.rank DESC, i.id DESC
        LIMIT 2`,
      [project.id, todo.id],
    );
    expect(columnTail.rows.map((row) => row.id)).toEqual([
      createdAfterTransition.id,
      selected.id,
    ]);
    expect(columnTail.rows[0]?.rank).toMatch(/^\d+\.\d{10}$/);

    await expect(
      transitionIssue(identity, access!, issues[1]!.key, {
        transitionId: null,
        destinationColumnId: todo.id,
        destinationStatusId: selected.statusId,
        beforeIssueId: after.id,
        afterIssueId: anchor.id,
        version: selected.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "INVALID_RANK_NEIGHBORS",
      status: 409,
    });

    const writes = await getPool().query<{
      event_type: string;
      action: string;
      topic: string;
    }>(
      `SELECT ie.event_type, ae.action, oe.topic
         FROM issue_events ie
         JOIN audit_events ae
           ON ae.target_id = ie.issue_id AND ae.correlation_id = ie.correlation_id
         JOIN outbox_events oe
           ON oe.aggregate_id = ie.issue_id
          AND oe.payload ->> 'correlationId' = ie.correlation_id::text
        WHERE ie.issue_id = $1 AND ie.event_type = 'REORDERED'`,
      [issues.at(-1)!.id],
    );
    expect(writes.rows).toEqual([
      {
        event_type: "REORDERED",
        action: "issue.reordered",
        topic: "issue.reordered",
      },
    ]);
  });

  it("configures versioned WIP warnings with scoped audited writes", async () => {
    const {
      createProject,
      getBoard,
      getBoardSettings,
      getPool,
      getProjectAccess,
      updateBoardColumnWipLimit,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    const viewerId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'WIP Test', $2)`,
      [organizationId, `wip-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES
         ($1, $2, $3, 'WIP Admin', 'unused'),
         ($4, $2, $5, 'WIP Member', 'unused'),
         ($6, $2, $7, 'WIP Viewer', 'unused')`,
      [
        adminId,
        organizationId,
        `${adminId}@example.test`,
        memberId,
        `${memberId}@example.test`,
        viewerId,
        `${viewerId}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER'), ($1, $4, 'MEMBER')`,
      [organizationId, adminId, memberId, viewerId],
    );
    const identity = {
      id: adminId,
      organizationId,
      email: `${adminId}@example.test`,
      displayName: "WIP Admin",
      organizationRole: "ADMIN" as const,
    };
    const project = await createProject(identity, {
      key: "WIP",
      name: "WIP Test",
    });
    const otherProject = await createProject(identity, {
      key: "WIPX",
      name: "Other WIP Test",
    });
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER'), ($1, $2, $4, 'VIEWER')`,
      [organizationId, project.id, memberId, viewerId],
    );
    const access = await getProjectAccess(adminId, project.key);
    const memberAccess = await getProjectAccess(memberId, project.key);
    const viewerAccess = await getProjectAccess(viewerId, project.key);
    expect(access).not.toBeNull();
    expect(() =>
      assertCapability(
        memberAccess!.organizationRole,
        memberAccess!.projectRole,
        "project:admin",
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
    expect(() =>
      assertCapability(
        viewerAccess!.organizationRole,
        viewerAccess!.projectRole,
        "project:admin",
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));

    const initial = await getBoardSettings(access!);
    const todo = initial.columns.find((column) => column.name === "To Do")!;
    expect(todo).toMatchObject({ wipLimit: null, version: 1 });
    const configured = await updateBoardColumnWipLimit(
      identity,
      access!,
      todo.id,
      { wipLimit: 2, version: todo.version },
    );
    expect(configured).toMatchObject({ wipLimit: 2, version: 2 });
    const unchanged = await updateBoardColumnWipLimit(
      identity,
      access!,
      todo.id,
      { wipLimit: 2, version: configured.version },
    );
    expect(unchanged.version).toBe(configured.version);
    await expect(
      updateBoardColumnWipLimit(identity, access!, todo.id, {
        wipLimit: 3,
        version: todo.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "VERSION_CONFLICT",
      status: 409,
    });

    const otherAccess = await getProjectAccess(adminId, otherProject.key);
    const otherSettings = await getBoardSettings(otherAccess!);
    await expect(
      updateBoardColumnWipLimit(
        identity,
        access!,
        otherSettings.columns[0]!.id,
        { wipLimit: 4, version: 1 },
      ),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "BOARD_COLUMN_NOT_FOUND",
      status: 404,
    });

    const cleared = await updateBoardColumnWipLimit(
      identity,
      access!,
      todo.id,
      { wipLimit: null, version: configured.version },
    );
    expect(cleared).toMatchObject({ wipLimit: null, version: 3 });
    const board = await getBoard(project.boardId, access!);
    expect(
      board?.columns.find((column) => column.id === todo.id),
    ).toMatchObject({ wipLimit: null, version: 3 });

    const writes = await getPool().query<{
      audit_count: string;
      outbox_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM audit_events
           WHERE target_id = $1 AND action = 'board.column.wip_limit.updated') AS audit_count,
         (SELECT count(*) FROM outbox_events
           WHERE aggregate_id = $1 AND topic = 'board.column.wip_limit.updated') AS outbox_count`,
      [todo.id],
    );
    expect(writes.rows[0]).toEqual({ audit_count: "2", outbox_count: "2" });
  });

  it("versions workflow configuration and requires explicit used-status migration", async () => {
    const {
      createIssue,
      createProject,
      getIssueDetail,
      getPool,
      getProjectAccess,
      getWorkflowSettings,
      updateWorkflowConfiguration,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Workflow Test', $2)`,
      [organizationId, `workflow-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users
        (id, organization_id, email, display_name, password_hash)
       VALUES
        ($1, $2, 'workflow-admin@example.test', 'Workflow Admin', 'unused'),
        ($3, $2, 'workflow-member@example.test', 'Workflow Member', 'unused')`,
      [adminId, organizationId, memberId],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER')`,
      [organizationId, adminId, memberId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: "workflow-admin@example.test",
      displayName: "Workflow Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: "workflow-member@example.test",
      displayName: "Workflow Member",
      organizationRole: "MEMBER" as const,
    };
    const project = await createProject(admin, {
      key: "WFL",
      name: "Workflow Test",
    });
    const otherProject = await createProject(admin, {
      key: "WFX",
      name: "Other Workflow Test",
    });
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER')`,
      [organizationId, project.id, memberId],
    );
    const access = await getProjectAccess(adminId, project.key);
    const memberAccess = await getProjectAccess(memberId, project.key);
    const otherAccess = await getProjectAccess(adminId, otherProject.key);
    const issue = await createIssue(admin, access!, {
      summary: "Migrate my status",
      description: "",
      priority: "MEDIUM",
      issueType: "TASK",
    });
    const initial = await getWorkflowSettings(access!);
    const backlog = initial.statuses.find(
      (status) => status.name === "Backlog",
    )!;
    const selected = initial.statuses.find(
      (status) => status.name === "Selected",
    )!;
    const inProgress = initial.statuses.find(
      (status) => status.name === "In Progress",
    )!;
    const inProgressColumn = initial.columns.find(
      (column) => column.name === "In Progress",
    )!;
    const blockedId = randomUUID();
    const firstUpdate = {
      version: initial.workflow.version,
      statuses: [
        ...initial.statuses.map((status) => ({
          id: status.id,
          name: status.id === backlog.id ? "Intake" : status.name,
          category: status.category,
          color: status.color,
          columnId: status.columnId,
        })),
        {
          id: blockedId,
          name: "Blocked",
          category: "IN_PROGRESS" as const,
          color: "#ef4444",
          columnId: inProgressColumn.id,
        },
      ],
      transitions: [
        ...initial.transitions.map((transition) => ({
          fromStatusId: transition.fromStatusId,
          toStatusId: transition.toStatusId,
        })),
        { fromStatusId: inProgress.id, toStatusId: blockedId },
      ],
      removedStatusMigrations: [],
    } satisfies UpdateWorkflowConfigurationInput;
    const configured = await updateWorkflowConfiguration(
      admin,
      access!,
      firstUpdate,
    );
    expect(configured.workflow.version).toBe(2);
    expect(configured.statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: backlog.id, name: "Intake" }),
        expect.objectContaining({ id: blockedId, name: "Blocked" }),
      ]),
    );
    expect(configured.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromStatusId: inProgress.id,
          toStatusId: blockedId,
        }),
      ]),
    );
    await expect(
      updateWorkflowConfiguration(admin, access!, firstUpdate),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "VERSION_CONFLICT",
      status: 409,
    });
    const configuredInput = {
      version: configured.workflow.version,
      statuses: configured.statuses.map((status) => ({
        id: status.id,
        name: status.name,
        category: status.category,
        color: status.color,
        columnId: status.columnId,
      })),
      transitions: configured.transitions.map((transition) => ({
        fromStatusId: transition.fromStatusId,
        toStatusId: transition.toStatusId,
      })),
      removedStatusMigrations: [],
    } satisfies UpdateWorkflowConfigurationInput;
    await expect(
      updateWorkflowConfiguration(member, memberAccess!, configuredInput),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });
    const other = await getWorkflowSettings(otherAccess!);
    await expect(
      updateWorkflowConfiguration(admin, access!, {
        ...configuredInput,
        statuses: configuredInput.statuses.map((status, index) => ({
          ...status,
          columnId: index === 0 ? other.columns[0]!.id : status.columnId,
        })),
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "INVALID_COLUMN_MAPPING",
      status: 422,
    });

    const withoutIntake = {
      ...configuredInput,
      statuses: configuredInput.statuses.filter(
        (status) => status.id !== backlog.id,
      ),
      transitions: configuredInput.transitions.filter(
        (transition) =>
          transition.fromStatusId !== backlog.id &&
          transition.toStatusId !== backlog.id,
      ),
    } satisfies UpdateWorkflowConfigurationInput;
    await expect(
      updateWorkflowConfiguration(admin, access!, withoutIntake),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "STATUS_IN_USE",
      status: 409,
    });
    const migrated = await updateWorkflowConfiguration(admin, access!, {
      ...withoutIntake,
      removedStatusMigrations: [
        { fromStatusId: backlog.id, toStatusId: selected.id },
      ],
    });
    expect(migrated.workflow.version).toBe(3);
    expect(migrated.statuses.map((status) => status.id)).not.toContain(
      backlog.id,
    );
    const migratedIssue = await getIssueDetail(issue.key, access!);
    expect(migratedIssue).toMatchObject({
      statusId: selected.id,
      version: issue.version + 1,
    });
    expect(migratedIssue?.events.at(-1)).toMatchObject({
      eventType: "TRANSITIONED",
      payload: { reason: "WORKFLOW_STATUS_MIGRATION" },
    });
    const newIssue = await createIssue(admin, access!, {
      summary: "Created after workflow edit",
      description: "",
      priority: "LOW",
      issueType: "TASK",
    });
    expect(newIssue.statusId).toBe(selected.id);

    const writes = await getPool().query<{
      workflow_audits: string;
      workflow_outbox: string;
      migration_audits: string;
    }>(
      `SELECT
        (SELECT count(*) FROM audit_events
          WHERE target_id = $1 AND action = 'workflow.updated') AS workflow_audits,
        (SELECT count(*) FROM outbox_events
          WHERE aggregate_id = $1 AND topic = 'workflow.updated') AS workflow_outbox,
        (SELECT count(*) FROM audit_events
          WHERE target_id = $2 AND action = 'issue.workflow_migrated') AS migration_audits`,
      [initial.workflow.id, issue.id],
    );
    expect(writes.rows[0]).toEqual({
      workflow_audits: "2",
      workflow_outbox: "2",
      migration_audits: "1",
    });
  });

  it("updates editable fields atomically and rejects stale or invalid writes", async () => {
    const {
      createIssue,
      createProject,
      getBoard,
      getBoardAccess,
      getPool,
      updateIssue,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const userId = randomUUID();
    const assigneeId = randomUUID();
    const viewerId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Edit Test', $2)`,
      [organizationId, `edit-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES
         ($1, $2, $3, 'Editor', 'unused'),
         ($4, $2, $5, 'Assignee', 'unused'),
         ($6, $2, $7, 'Viewer', 'unused')`,
      [
        userId,
        organizationId,
        `${userId}@example.test`,
        assigneeId,
        `${assigneeId}@example.test`,
        viewerId,
        `${viewerId}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER'), ($1, $4, 'MEMBER')`,
      [organizationId, userId, assigneeId, viewerId],
    );
    const identity = {
      id: userId,
      organizationId,
      email: `${userId}@example.test`,
      displayName: "Editor",
      organizationRole: "ADMIN" as const,
    };
    const project = await createProject(identity, {
      key: "EDT",
      name: "Edit Test",
    });
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER'), ($1, $2, $4, 'VIEWER')`,
      [organizationId, project.id, assigneeId, viewerId],
    );
    const access = await getBoardAccess(userId, project.boardId);
    expect(access).not.toBeNull();
    const board = await getBoard(project.boardId, access!);
    expect(board?.assignees.map((assignee) => assignee.id)).toEqual(
      expect.arrayContaining([userId, assigneeId]),
    );
    expect(board?.assignees.map((assignee) => assignee.id)).not.toContain(
      viewerId,
    );
    const issue = await createIssue(identity, access!, {
      summary: "Original summary",
      description: "",
      priority: "MEDIUM",
      issueType: "TASK",
    });

    const update = {
      summary: "Updated summary",
      description: "Updated description",
      priority: "CRITICAL" as const,
      issueType: issue.issueType,
      assigneeId,
      labels: issue.labels,
      parentIssueKey: issue.parent?.key ?? null,
      estimatePoints: 13,
      dueDate: "2026-12-15",
      version: issue.version,
    };
    const updated = await updateIssue(identity, access!, issue.key, update);
    expect(updated).toMatchObject({
      summary: update.summary,
      description: update.description,
      priority: update.priority,
      assignee: { id: assigneeId, displayName: "Assignee" },
      estimatePoints: 13,
      dueDate: "2026-12-15",
      version: issue.version + 1,
    });
    expect(updated.events.at(-1)).toMatchObject({
      eventType: "UPDATED",
      payload: {
        fields: [
          "summary",
          "description",
          "priority",
          "assignee",
          "estimatePoints",
          "dueDate",
        ],
        fromVersion: issue.version,
        toVersion: issue.version + 1,
      },
    });

    await expect(
      updateIssue(identity, access!, issue.key, {
        ...update,
        summary: "Stale overwrite",
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "VERSION_CONFLICT",
      status: 409,
    });
    await expect(
      updateIssue(identity, access!, issue.key, {
        ...update,
        assigneeId: viewerId,
        version: updated.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "INVALID_ASSIGNEE",
      status: 422,
    });

    const unchanged = await updateIssue(identity, access!, issue.key, {
      ...update,
      version: updated.version,
    });
    expect(unchanged.version).toBe(updated.version);

    const events = await getPool().query<{
      event_type: string;
      payload_json: Record<string, unknown>;
    }>(
      "SELECT event_type, payload_json FROM issue_events WHERE issue_id = $1 ORDER BY created_at, id",
      [issue.id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "CREATED",
      "UPDATED",
    ]);
    const audits = await getPool().query<{
      metadata: Record<string, unknown>;
    }>(
      `SELECT metadata FROM audit_events
        WHERE target_id = $1 AND action = 'issue.updated'`,
      [issue.id],
    );
    expect(audits.rows).toEqual([
      {
        metadata: {
          fields: [
            "summary",
            "description",
            "priority",
            "assignee",
            "estimatePoints",
            "dueDate",
          ],
        },
      },
    ]);
    const outbox = await getPool().query<{ topic: string }>(
      `SELECT topic FROM outbox_events
        WHERE aggregate_id = $1 AND topic = 'issue.updated'`,
      [issue.id],
    );
    expect(outbox.rows).toEqual([{ topic: "issue.updated" }]);
  });

  it("persists labels and enforces the Epic to standard issue to Subtask hierarchy", async () => {
    const {
      createIssue,
      createProject,
      getBoard,
      getProjectAccess,
      getPool,
      updateIssue,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const userId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Hierarchy Test', $2)`,
      [organizationId, `hierarchy-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Hierarchy Admin', 'unused')`,
      [userId, organizationId, `${userId}@example.test`],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')`,
      [organizationId, userId],
    );
    const identity = {
      id: userId,
      organizationId,
      email: `${userId}@example.test`,
      displayName: "Hierarchy Admin",
      organizationRole: "ADMIN" as const,
    };
    const project = await createProject(identity, {
      key: "HIR",
      name: "Hierarchy Test",
    });
    const otherProject = await createProject(identity, {
      key: "ALT",
      name: "Other Project",
    });
    const access = await getProjectAccess(userId, project.key);
    const otherAccess = await getProjectAccess(userId, otherProject.key);
    expect(access).not.toBeNull();
    expect(otherAccess).not.toBeNull();

    const otherEpic = await createIssue(identity, otherAccess!, {
      summary: "Other project epic",
      description: "",
      priority: "MEDIUM",
      issueType: "EPIC",
    });
    const epic = await createIssue(identity, access!, {
      summary: "Release one",
      description: "Release scope",
      priority: "HIGH",
      issueType: "EPIC",
      assigneeId: userId,
      labels: ["Urgent", "Roadmap"],
      parentIssueKey: null,
    });
    expect(epic).toMatchObject({
      issueType: "EPIC",
      assignee: { id: userId, displayName: "Hierarchy Admin" },
      labels: ["Roadmap", "Urgent"],
      parent: null,
    });
    const story = await createIssue(identity, access!, {
      summary: "Customer workflow",
      description: "",
      priority: "MEDIUM",
      issueType: "STORY",
      labels: ["Customer Request", "roadmap"],
      parentIssueKey: epic.key,
    });
    expect(story).toMatchObject({
      issueType: "STORY",
      labels: ["Customer Request", "Roadmap"],
      parent: {
        id: epic.id,
        key: epic.key,
        summary: epic.summary,
        issueType: "EPIC",
      },
    });
    const subtask = await createIssue(identity, access!, {
      summary: "Wire the form",
      description: "",
      priority: "LOW",
      issueType: "SUBTASK",
      parentIssueKey: story.key,
    });
    expect(subtask.parent).toMatchObject({
      id: story.id,
      key: story.key,
      issueType: "STORY",
    });

    await expect(
      createIssue(identity, access!, {
        summary: "Parentless subtask",
        description: "",
        priority: "LOW",
        issueType: "SUBTASK",
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "PARENT_REQUIRED",
      status: 422,
    });
    await expect(
      createIssue(identity, access!, {
        summary: "Invalid child",
        description: "",
        priority: "LOW",
        issueType: "TASK",
        parentIssueKey: story.key,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "INVALID_PARENT_HIERARCHY",
      status: 422,
    });
    await expect(
      createIssue(identity, access!, {
        summary: "Cross-project child",
        description: "",
        priority: "LOW",
        issueType: "TASK",
        parentIssueKey: otherEpic.key,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "INVALID_PARENT",
      status: 422,
    });
    await expect(
      updateIssue(identity, access!, story.key, {
        summary: story.summary,
        description: story.description,
        priority: story.priority,
        issueType: "EPIC",
        assigneeId: story.assignee?.id ?? null,
        labels: story.labels,
        parentIssueKey: null,
        version: story.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "INCOMPATIBLE_CHILD_HIERARCHY",
      status: 409,
    });
    await expect(
      updateIssue(identity, access!, story.key, {
        summary: story.summary,
        description: story.description,
        priority: story.priority,
        issueType: "SUBTASK",
        assigneeId: story.assignee?.id ?? null,
        labels: story.labels,
        parentIssueKey: story.key,
        version: story.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "ISSUE_CYCLE",
      status: 422,
    });

    const updated = await updateIssue(identity, access!, subtask.key, {
      summary: subtask.summary,
      description: subtask.description,
      priority: subtask.priority,
      issueType: "BUG",
      assigneeId: subtask.assignee?.id ?? null,
      labels: ["Shippable", "roadmap"],
      parentIssueKey: epic.key,
      version: subtask.version,
    });
    expect(updated).toMatchObject({
      issueType: "BUG",
      labels: ["Roadmap", "Shippable"],
      parent: { id: epic.id, key: epic.key, issueType: "EPIC" },
      version: subtask.version + 1,
    });
    expect(updated.events.at(-1)).toMatchObject({
      eventType: "UPDATED",
      payload: {
        fields: ["issueType", "parent", "labels"],
        fromVersion: subtask.version,
        toVersion: subtask.version + 1,
      },
    });

    const board = await getBoard(project.boardId, access!);
    expect(
      board?.issues.find((issue) => issue.id === updated.id),
    ).toMatchObject({
      labels: ["Roadmap", "Shippable"],
      parent: { key: epic.key },
    });
    const writes = await getPool().query<{
      label_count: string;
      audit_count: string;
      outbox_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM labels
           WHERE organization_id = $1 AND normalized_name = 'roadmap') AS label_count,
         (SELECT count(*) FROM audit_events
           WHERE target_id = $2 AND action = 'issue.updated') AS audit_count,
         (SELECT count(*) FROM outbox_events
           WHERE aggregate_id = $2 AND topic = 'issue.updated') AS outbox_count`,
      [organizationId, subtask.id],
    );
    expect(writes.rows[0]).toEqual({
      label_count: "1",
      audit_count: "1",
      outbox_count: "1",
    });
  });

  it("soft-deletes with member authority and restores with administrator authority", async () => {
    const {
      createIssue,
      createProject,
      deleteIssue,
      getDeletedIssueAccess,
      getIssueAccess,
      getIssueDetail,
      getPool,
      getProjectAccess,
      listDeletedIssues,
      restoreIssue,
      updateIssue,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    const viewerId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Lifecycle Test', $2)`,
      [organizationId, `lifecycle-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES
         ($1, $2, $3, 'Lifecycle Admin', 'unused'),
         ($4, $2, $5, 'Lifecycle Member', 'unused'),
         ($6, $2, $7, 'Lifecycle Viewer', 'unused')`,
      [
        adminId,
        organizationId,
        `${adminId}@example.test`,
        memberId,
        `${memberId}@example.test`,
        viewerId,
        `${viewerId}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER'), ($1, $4, 'MEMBER')`,
      [organizationId, adminId, memberId, viewerId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: `${adminId}@example.test`,
      displayName: "Lifecycle Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: `${memberId}@example.test`,
      displayName: "Lifecycle Member",
      organizationRole: "MEMBER" as const,
    };
    const project = await createProject(admin, {
      key: "LIF",
      name: "Lifecycle Test",
    });
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER'), ($1, $2, $4, 'VIEWER')`,
      [organizationId, project.id, memberId, viewerId],
    );
    const adminAccess = await getProjectAccess(adminId, project.key);
    const memberAccess = await getProjectAccess(memberId, project.key);
    const viewerAccess = await getProjectAccess(viewerId, project.key);
    expect(adminAccess).not.toBeNull();
    expect(memberAccess).not.toBeNull();
    expect(viewerAccess).not.toBeNull();
    expect(() =>
      assertCapability(
        memberAccess!.organizationRole,
        memberAccess!.projectRole,
        "issue:delete",
      ),
    ).not.toThrow();
    expect(() =>
      assertCapability(
        memberAccess!.organizationRole,
        memberAccess!.projectRole,
        "issue:restore",
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
    expect(() =>
      assertCapability(
        viewerAccess!.organizationRole,
        viewerAccess!.projectRole,
        "issue:delete",
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));

    const epic = await createIssue(admin, adminAccess!, {
      summary: "Lifecycle parent",
      description: "",
      priority: "MEDIUM",
      issueType: "EPIC",
    });
    const story = await createIssue(admin, adminAccess!, {
      summary: "Lifecycle child",
      description: "",
      priority: "MEDIUM",
      issueType: "STORY",
      assigneeId: memberId,
      parentIssueKey: epic.key,
    });

    await expect(
      deleteIssue(member, memberAccess!, epic.key, epic.version),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "ISSUE_HAS_ACTIVE_CHILDREN",
      status: 409,
    });
    await expect(
      deleteIssue(member, memberAccess!, story.key, story.version + 1),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "VERSION_CONFLICT",
      status: 409,
    });
    expect(await getIssueAccess(memberId, story.key)).not.toBeNull();

    await deleteIssue(member, memberAccess!, story.key, story.version);
    expect(await getIssueAccess(memberId, story.key)).toBeNull();
    expect(await getDeletedIssueAccess(memberId, story.key)).toMatchObject({
      projectId: project.id,
      projectRole: "MEMBER",
    });
    await expect(
      listDeletedIssues(member, memberAccess!),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });

    const incompatibleParent = await updateIssue(
      admin,
      adminAccess!,
      epic.key,
      {
        summary: epic.summary,
        description: epic.description,
        priority: epic.priority,
        issueType: "TASK",
        assigneeId: epic.assignee?.id ?? null,
        labels: epic.labels,
        parentIssueKey: null,
        version: epic.version,
      },
    );
    await expect(
      restoreIssue(admin, adminAccess!, story.key, story.version + 1),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "INVALID_PARENT_HIERARCHY",
      status: 422,
    });
    const compatibleParent = await updateIssue(admin, adminAccess!, epic.key, {
      summary: incompatibleParent.summary,
      description: incompatibleParent.description,
      priority: incompatibleParent.priority,
      issueType: "EPIC",
      assigneeId: incompatibleParent.assignee?.id ?? null,
      labels: incompatibleParent.labels,
      parentIssueKey: null,
      version: incompatibleParent.version,
    });

    await deleteIssue(
      member,
      memberAccess!,
      epic.key,
      compatibleParent.version,
    );
    const deleted = await listDeletedIssues(admin, adminAccess!);
    expect(deleted.project).toMatchObject({
      id: project.id,
      key: project.key,
      boardId: project.boardId,
    });
    expect(deleted.issues.map((issue) => issue.key).sort()).toEqual(
      [epic.key, story.key].sort(),
    );
    expect(
      deleted.issues.find((issue) => issue.key === story.key),
    ).toMatchObject({
      version: story.version + 1,
      deletedBy: { id: memberId, displayName: "Lifecycle Member" },
    });

    await expect(
      restoreIssue(admin, adminAccess!, story.key, story.version + 1),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "RESTORE_PARENT_NOT_ACTIVE",
      status: 409,
    });
    const restoredEpic = await restoreIssue(
      admin,
      adminAccess!,
      epic.key,
      compatibleParent.version + 1,
    );
    expect(restoredEpic).toMatchObject({
      id: epic.id,
      key: epic.key,
      version: compatibleParent.version + 2,
    });
    const restoredStory = await restoreIssue(
      admin,
      adminAccess!,
      story.key,
      story.version + 1,
    );
    expect(restoredStory).toMatchObject({
      id: story.id,
      key: story.key,
      version: story.version + 2,
      parent: { id: epic.id, key: epic.key },
      assignee: { id: memberId, displayName: "Lifecycle Member" },
    });
    expect(restoredStory.events.map((event) => event.eventType)).toEqual([
      "CREATED",
      "DELETED",
      "RESTORED",
    ]);
    expect(await getDeletedIssueAccess(adminId, story.key)).toBeNull();
    expect(await getIssueAccess(adminId, story.key)).not.toBeNull();
    expect(await getIssueDetail(story.key, adminAccess!)).toMatchObject({
      key: story.key,
      version: story.version + 2,
    });

    const writes = await getPool().query<{
      event_count: string;
      audit_count: string;
      outbox_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM issue_events
           WHERE issue_id IN ($1, $2) AND event_type IN ('DELETED', 'RESTORED')) AS event_count,
         (SELECT count(*) FROM audit_events
           WHERE target_id IN ($1, $2) AND action IN ('issue.deleted', 'issue.restored')) AS audit_count,
         (SELECT count(*) FROM outbox_events
           WHERE aggregate_id IN ($1, $2) AND topic IN ('issue.deleted', 'issue.restored')) AS outbox_count`,
      [epic.id, story.id],
    );
    expect(writes.rows[0]).toEqual({
      event_count: "4",
      audit_count: "4",
      outbox_count: "4",
    });
  });

  it("isolates tenants, traverses cursors, and deduplicates create retries", async () => {
    const {
      createIssue,
      createProject,
      getIssueAccess,
      getPool,
      getProjectAccess,
      listIssuesPage,
      listProjectsPage,
    } = await import("@vibe/database");
    const organizationA = randomUUID();
    const organizationB = randomUUID();
    const adminA = randomUUID();
    const viewerA = randomUUID();
    const adminB = randomUUID();

    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Tenant A', $2), ($3, 'Tenant B', $4)`,
      [
        organizationA,
        `tenant-a-${organizationA}`,
        organizationB,
        `tenant-b-${organizationB}`,
      ],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES
         ($1, $2, $3, 'Admin A', 'unused'),
         ($4, $2, $5, 'Viewer A', 'unused'),
         ($6, $7, $8, 'Admin B', 'unused')`,
      [
        adminA,
        organizationA,
        `${adminA}@example.test`,
        viewerA,
        `${viewerA}@example.test`,
        adminB,
        organizationB,
        `${adminB}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER'), ($4, $5, 'ADMIN')`,
      [organizationA, adminA, viewerA, organizationB, adminB],
    );
    const identityA = {
      id: adminA,
      organizationId: organizationA,
      email: `${adminA}@example.test`,
      displayName: "Admin A",
      organizationRole: "ADMIN" as const,
    };
    const identityB = {
      id: adminB,
      organizationId: organizationB,
      email: `${adminB}@example.test`,
      displayName: "Admin B",
      organizationRole: "ADMIN" as const,
    };
    const projectRequest = { key: "TEN", name: "Tenant Project" };
    const projectIdempotency = {
      key: `project-${randomUUID()}`,
      requestHash: "same-project-request",
    };
    const projectResults = await Promise.all([
      createProject(
        identityA,
        projectRequest,
        randomUUID(),
        projectIdempotency,
      ),
      createProject(
        identityA,
        projectRequest,
        randomUUID(),
        projectIdempotency,
      ),
    ]);
    expect(projectResults[1]).toEqual(projectResults[0]);
    const projectA = projectResults[0]!;
    await expect(
      createProject(
        identityA,
        { key: "DIFF", name: "Different payload" },
        randomUUID(),
        { ...projectIdempotency, requestHash: "different-project-request" },
      ),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });

    const projectB = await createProject(identityB, projectRequest);
    const additionalProjects = await Promise.all([
      createProject(identityA, { key: "TNA", name: "Alpha" }),
      createProject(identityA, { key: "TNZ", name: "Zulu" }),
    ]);
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'VIEWER')`,
      [organizationA, projectA.id, viewerA],
    );

    const accessA = await getProjectAccess(adminA, "TEN");
    const accessB = await getProjectAccess(adminB, "TEN");
    const viewerAccess = await getProjectAccess(viewerA, "TEN");
    expect(accessA).toMatchObject({
      organizationId: organizationA,
      projectId: projectA.id,
    });
    expect(accessB).toMatchObject({
      organizationId: organizationB,
      projectId: projectB.id,
    });
    expect(viewerAccess).toMatchObject({ projectRole: "VIEWER" });
    for (const capability of [
      "issue:create",
      "issue:edit",
      "issue:transition",
      "project:admin",
    ] as const) {
      expect(() =>
        assertCapability(
          viewerAccess!.organizationRole,
          viewerAccess!.projectRole,
          capability,
        ),
      ).toThrowError(
        expect.objectContaining<Partial<DomainError>>({
          code: "FORBIDDEN",
          status: 403,
        }),
      );
    }

    const pagedProjects = [];
    let projectCursor: string | undefined;
    do {
      const page = await listProjectsPage(identityA, {
        limit: 1,
        ...(projectCursor ? { cursor: projectCursor } : {}),
      });
      pagedProjects.push(...page.items);
      projectCursor = page.nextCursor ?? undefined;
    } while (projectCursor);
    expect(pagedProjects.map((project) => project.id).sort()).toEqual(
      [projectA, ...additionalProjects].map((project) => project.id).sort(),
    );
    expect(pagedProjects.map((project) => project.id)).not.toContain(
      projectB.id,
    );
    await expect(
      listProjectsPage(identityA, { cursor: "not-a-cursor", limit: 2 }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "INVALID_CURSOR",
      status: 400,
    });

    const issueInput = {
      summary: "Retry-safe issue",
      description: "Created once",
      priority: "HIGH" as const,
      issueType: "TASK" as const,
    };
    const issueIdempotency = {
      key: `issue-${randomUUID()}`,
      requestHash: "same-issue-request",
    };
    const issueResults = await Promise.all([
      createIssue(
        identityA,
        accessA!,
        issueInput,
        randomUUID(),
        issueIdempotency,
      ),
      createIssue(
        identityA,
        accessA!,
        issueInput,
        randomUUID(),
        issueIdempotency,
      ),
    ]);
    expect(issueResults[1]).toEqual(issueResults[0]);
    const issueA = issueResults[0]!;
    await expect(
      createIssue(
        identityA,
        accessA!,
        { ...issueInput, summary: "Different issue" },
        randomUUID(),
        { ...issueIdempotency, requestHash: "different-issue-request" },
      ),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });
    const moreIssues = await Promise.all(
      ["Second", "Third", "Fourth"].map((summary) =>
        createIssue(identityA, accessA!, { ...issueInput, summary }),
      ),
    );
    const issueB = await createIssue(identityB, accessB!, issueInput);

    const pagedIssues = [];
    let issueCursor: string | undefined;
    do {
      const page = await listIssuesPage(accessA!, {
        limit: 2,
        ...(issueCursor ? { cursor: issueCursor } : {}),
      });
      pagedIssues.push(...page.items);
      issueCursor = page.nextCursor ?? undefined;
    } while (issueCursor);
    expect(pagedIssues.map((issue) => issue.id)).toEqual(
      expect.arrayContaining([issueA, ...moreIssues].map((issue) => issue.id)),
    );
    expect(pagedIssues).toHaveLength(4);
    expect(
      pagedIssues.map((issue) => Number(issue.key.split("-").at(-1))),
    ).toEqual([1, 2, 3, 4]);
    expect(pagedIssues.map((issue) => issue.id)).not.toContain(issueB.id);
    expect(await getIssueAccess(adminA, "TEN-1")).toMatchObject({
      organizationId: organizationA,
      projectId: projectA.id,
    });
    expect(await getIssueAccess(adminB, "TEN-1")).toMatchObject({
      organizationId: organizationB,
      projectId: projectB.id,
    });

    const writeCounts = await getPool().query<{
      issue_count: string;
      event_count: string;
      outbox_count: string;
      sequence_counter: number;
    }>(
      `SELECT
         (SELECT count(*) FROM issues WHERE id = $1) AS issue_count,
         (SELECT count(*) FROM issue_events WHERE issue_id = $1 AND event_type = 'CREATED') AS event_count,
         (SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND topic = 'issue.created') AS outbox_count,
         (SELECT sequence_counter FROM projects WHERE id = $2) AS sequence_counter`,
      [issueA.id, projectA.id],
    );
    expect(writeCounts.rows[0]).toEqual({
      issue_count: "1",
      event_count: "1",
      outbox_count: "1",
      sequence_counter: 4,
    });
    const projectWrites = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM audit_events
        WHERE target_id = $1 AND action = 'project.created'`,
      [projectA.id],
    );
    expect(projectWrites.rows[0]?.count).toBe("1");
  });

  it("administers project roles atomically without crossing authorization boundaries", async () => {
    const {
      createIssue,
      createProject,
      getBoard,
      getProjectAccess,
      getPool,
      listProjectMembers,
      removeProjectMember,
      setProjectMember,
      updateIssue,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const outsideOrganizationId = randomUUID();
    const creatorId = randomUUID();
    const projectAdminId = randomUUID();
    const memberId = randomUUID();
    const viewerId = randomUUID();
    const outsiderId = randomUUID();

    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Membership Test', $2), ($3, 'Outside', $4)`,
      [
        organizationId,
        `membership-${organizationId}`,
        outsideOrganizationId,
        `outside-${outsideOrganizationId}`,
      ],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES
         ($1, $2, $3, 'Creator', 'unused'),
         ($4, $2, $5, 'Project Admin', 'unused'),
         ($6, $2, $7, 'Member', 'unused'),
         ($8, $2, $9, 'Viewer', 'unused'),
         ($10, $11, $12, 'Outsider', 'unused')`,
      [
        creatorId,
        organizationId,
        `${creatorId}@example.test`,
        projectAdminId,
        `${projectAdminId}@example.test`,
        memberId,
        `${memberId}@example.test`,
        viewerId,
        `${viewerId}@example.test`,
        outsiderId,
        outsideOrganizationId,
        `${outsiderId}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES
         ($1, $2, 'ADMIN'),
         ($1, $3, 'MEMBER'),
         ($1, $4, 'MEMBER'),
         ($1, $5, 'MEMBER'),
         ($6, $7, 'MEMBER')`,
      [
        organizationId,
        creatorId,
        projectAdminId,
        memberId,
        viewerId,
        outsideOrganizationId,
        outsiderId,
      ],
    );
    const creator = {
      id: creatorId,
      organizationId,
      email: `${creatorId}@example.test`,
      displayName: "Creator",
      organizationRole: "ADMIN" as const,
    };
    const projectAdmin = {
      id: projectAdminId,
      organizationId,
      email: `${projectAdminId}@example.test`,
      displayName: "Project Admin",
      organizationRole: "MEMBER" as const,
    };
    const regularMember = {
      id: memberId,
      organizationId,
      email: `${memberId}@example.test`,
      displayName: "Member",
      organizationRole: "MEMBER" as const,
    };
    const project = await createProject(creator, {
      key: "MEM",
      name: "Membership Test",
    });
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'ADMIN')`,
      [organizationId, project.id, projectAdminId],
    );
    const adminAccess = await getProjectAccess(projectAdminId, project.key);
    expect(adminAccess).toMatchObject({ projectRole: "ADMIN" });

    const initialView = await listProjectMembers(projectAdmin, adminAccess!);
    expect(initialView.project).toMatchObject({
      id: project.id,
      key: project.key,
      boardId: project.boardId,
    });
    expect(initialView.members.map((member) => member.id).sort()).toEqual(
      [creatorId, projectAdminId, memberId, viewerId].sort(),
    );
    expect(initialView.members.map((member) => member.id)).not.toContain(
      outsiderId,
    );

    await setProjectMember(projectAdmin, adminAccess!, memberId, "MEMBER");
    await setProjectMember(projectAdmin, adminAccess!, memberId, "MEMBER");
    await setProjectMember(projectAdmin, adminAccess!, viewerId, "MEMBER");
    const viewer = await setProjectMember(
      projectAdmin,
      adminAccess!,
      viewerId,
      "VIEWER",
    );
    expect(viewer.projectRole).toBe("VIEWER");

    const memberAccess = await getProjectAccess(memberId, project.key);
    await expect(
      listProjectMembers(regularMember, memberAccess!),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });
    await expect(
      setProjectMember(projectAdmin, adminAccess!, outsiderId, "MEMBER"),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "ORGANIZATION_MEMBER_NOT_FOUND",
      status: 404,
    });

    const issue = await createIssue(projectAdmin, adminAccess!, {
      summary: "Assigned work",
      description: "",
      priority: "MEDIUM",
      issueType: "TASK",
    });
    await updateIssue(projectAdmin, adminAccess!, issue.key, {
      summary: issue.summary,
      description: issue.description,
      priority: issue.priority,
      issueType: issue.issueType,
      assigneeId: memberId,
      labels: issue.labels,
      parentIssueKey: issue.parent?.key ?? null,
      version: issue.version,
    });
    await expect(
      setProjectMember(projectAdmin, adminAccess!, memberId, "VIEWER"),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "MEMBER_HAS_ASSIGNED_ISSUES",
      status: 409,
    });
    await expect(
      removeProjectMember(projectAdmin, adminAccess!, memberId),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "MEMBER_HAS_ASSIGNED_ISSUES",
      status: 409,
    });

    await removeProjectMember(projectAdmin, adminAccess!, viewerId);
    await removeProjectMember(projectAdmin, adminAccess!, creatorId);
    await expect(
      setProjectMember(projectAdmin, adminAccess!, projectAdminId, "MEMBER"),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "LAST_PROJECT_ADMIN",
      status: 409,
    });
    await expect(
      removeProjectMember(projectAdmin, adminAccess!, projectAdminId),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "LAST_PROJECT_ADMIN",
      status: 409,
    });

    const board = await getBoard(project.boardId, adminAccess!);
    expect(board?.assignees.map((assignee) => assignee.id)).toContain(memberId);
    expect(board?.assignees.map((assignee) => assignee.id)).not.toContain(
      viewerId,
    );
    const membershipWrites = await getPool().query<{
      action: string;
    }>(
      `SELECT action FROM audit_events
        WHERE target_id = $1 AND action LIKE 'project.member_%'
        ORDER BY created_at, id`,
      [project.id],
    );
    expect(membershipWrites.rows.map((row) => row.action)).toEqual([
      "project.member_added",
      "project.member_added",
      "project.member_role_changed",
      "project.member_removed",
      "project.member_removed",
    ]);
    const membershipOutbox = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM outbox_events
        WHERE aggregate_id = $1 AND topic = 'project.membership_changed'`,
      [project.id],
    );
    expect(membershipOutbox.rows[0]?.count).toBe("5");
  });

  it("fans committed board changes only to subscribers for the matching project", async () => {
    const {
      createIssue,
      createProject,
      getBoardAccess,
      getBoardSettings,
      getPool,
      subscribeToBoardChanges,
      updateBoardColumnWipLimit,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const userId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Realtime Test', $2)`,
      [organizationId, `realtime-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Realtime Admin', 'unused')`,
      [userId, organizationId, `${userId}@example.test`],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')`,
      [organizationId, userId],
    );
    const identity = {
      id: userId,
      organizationId,
      email: `${userId}@example.test`,
      displayName: "Realtime Admin",
      organizationRole: "ADMIN" as const,
    };
    const projectA = await createProject(identity, {
      key: "RTA",
      name: "Realtime A",
    });
    const projectB = await createProject(identity, {
      key: "RTB",
      name: "Realtime B",
    });
    const accessA = await getBoardAccess(userId, projectA.boardId);
    const accessB = await getBoardAccess(userId, projectB.boardId);
    expect(accessA).not.toBeNull();
    expect(accessB).not.toBeNull();

    const changesA: BoardChangeEvent[] = [];
    const changesB: BoardChangeEvent[] = [];
    let resolveA: ((event: BoardChangeEvent) => void) | null = null;
    let resolveB: ((event: BoardChangeEvent) => void) | null = null;
    const stopA = await subscribeToBoardChanges(projectA.id, (message) => {
      if (message.type !== "change") return;
      changesA.push(message.event);
      resolveA?.(message.event);
      resolveA = null;
    });
    const stopB = await subscribeToBoardChanges(projectB.id, (message) => {
      if (message.type !== "change") return;
      changesB.push(message.event);
      resolveB?.(message.event);
      resolveB = null;
    });

    try {
      const nextA = new Promise<BoardChangeEvent>((resolve) => {
        resolveA = resolve;
      });
      const issueA = await createIssue(identity, accessA!, {
        summary: "Realtime issue A",
        description: "",
        priority: "MEDIUM",
        issueType: "TASK",
      });
      await expect(nextA).resolves.toMatchObject({
        projectId: projectA.id,
        entity: "issue",
        entityId: issueA.id,
        version: 1,
        operation: "INSERT",
      });
      expect(changesB).toEqual([]);

      const settings = await getBoardSettings(accessA!);
      const column = settings.columns[0]!;
      const nextColumnA = new Promise<BoardChangeEvent>((resolve) => {
        resolveA = resolve;
      });
      await updateBoardColumnWipLimit(identity, accessA!, column.id, {
        wipLimit: 2,
        version: column.version,
      });
      await expect(nextColumnA).resolves.toMatchObject({
        projectId: projectA.id,
        entity: "board_column",
        entityId: column.id,
        version: column.version + 1,
        operation: "UPDATE",
      });
      expect(changesB).toEqual([]);

      const nextB = new Promise<BoardChangeEvent>((resolve) => {
        resolveB = resolve;
      });
      const issueB = await createIssue(identity, accessB!, {
        summary: "Realtime issue B",
        description: "",
        priority: "MEDIUM",
        issueType: "TASK",
      });
      await expect(nextB).resolves.toMatchObject({
        projectId: projectB.id,
        entityId: issueB.id,
      });
      expect(changesA).toHaveLength(2);
    } finally {
      stopA();
      stopB();
    }
  });

  it("stores chronological comments with exactly-once mentions and durable watcher choices", async () => {
    const {
      createIssue,
      createIssueComment,
      createProject,
      getIssueCollaboration,
      getPool,
      getProjectAccess,
      setIssueWatching,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    const viewerId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Collaboration Test', $2)`,
      [organizationId, `collaboration-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users
        (id, organization_id, email, display_name, password_hash)
       VALUES
        ($1, $2, 'collab-admin@example.test', 'Collab Admin', 'unused'),
        ($3, $2, 'collab-member@example.test', 'Collab Member', 'unused'),
        ($4, $2, 'collab-viewer@example.test', 'Collab Viewer', 'unused')`,
      [adminId, organizationId, memberId, viewerId],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER'), ($1, $4, 'MEMBER')`,
      [organizationId, adminId, memberId, viewerId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: "collab-admin@example.test",
      displayName: "Collab Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: "collab-member@example.test",
      displayName: "Collab Member",
      organizationRole: "MEMBER" as const,
    };
    const viewer = {
      id: viewerId,
      organizationId,
      email: "collab-viewer@example.test",
      displayName: "Collab Viewer",
      organizationRole: "MEMBER" as const,
    };
    const project = await createProject(admin, {
      key: "COL",
      name: "Collaboration Test",
    });
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER'), ($1, $2, $4, 'VIEWER')`,
      [organizationId, project.id, memberId, viewerId],
    );
    const adminAccess = await getProjectAccess(adminId, project.key);
    const memberAccess = await getProjectAccess(memberId, project.key);
    const viewerAccess = await getProjectAccess(viewerId, project.key);
    const issue = await createIssue(admin, adminAccess!, {
      summary: "Discuss this work",
      description: "",
      priority: "MEDIUM",
      issueType: "TASK",
      assigneeId: memberId,
    });
    const idempotency = {
      key: "comment-request-0001",
      requestHash: "same-comment-request",
    };
    const first = await createIssueComment(
      admin,
      adminAccess!,
      issue.key,
      "Please review @collab-member@example.test @COLLAB-MEMBER@example.test",
      randomUUID(),
      idempotency,
    );
    expect(first.comments).toHaveLength(1);
    expect(first.comments[0]).toMatchObject({
      author: { id: adminId },
      mentions: [{ id: memberId, email: "collab-member@example.test" }],
    });
    expect(first).toMatchObject({ isWatching: true, watcherCount: 2 });

    const replay = await createIssueComment(
      admin,
      adminAccess!,
      issue.key,
      "Please review @collab-member@example.test @COLLAB-MEMBER@example.test",
      randomUUID(),
      idempotency,
    );
    expect(replay.comments).toHaveLength(1);
    const writes = await getPool().query<{
      comment_count: string;
      mention_count: string;
      mention_event_count: string;
    }>(
      `SELECT
        (SELECT count(*) FROM comments WHERE issue_id = $1) AS comment_count,
        (SELECT count(*) FROM comment_mentions cm
          JOIN comments c ON c.id = cm.comment_id WHERE c.issue_id = $1) AS mention_count,
        (SELECT count(*) FROM outbox_events
          WHERE topic = 'notification.mention' AND payload ->> 'issueId' = $1::text)
          AS mention_event_count`,
      [issue.id],
    );
    expect(writes.rows[0]).toEqual({
      comment_count: "1",
      mention_count: "1",
      mention_event_count: "1",
    });

    const unwatched = await setIssueWatching(
      admin,
      adminAccess!,
      issue.key,
      false,
    );
    expect(unwatched.isWatching).toBe(false);
    await createIssueComment(
      member,
      memberAccess!,
      issue.key,
      "Follow-up in chronological order",
    );
    const afterFollowUp = await getIssueCollaboration(
      adminAccess!,
      issue.key,
      adminId,
    );
    expect(afterFollowUp.comments.map((comment) => comment.body)).toEqual([
      "Please review @collab-member@example.test @COLLAB-MEMBER@example.test",
      "Follow-up in chronological order",
    ]);
    expect(afterFollowUp.isWatching).toBe(false);

    await expect(
      createIssueComment(
        viewer,
        viewerAccess!,
        issue.key,
        "Viewer cannot comment",
      ),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });
    const viewerWatching = await setIssueWatching(
      viewer,
      viewerAccess!,
      issue.key,
      true,
    );
    expect(viewerWatching.isWatching).toBe(true);
    await setIssueWatching(viewer, viewerAccess!, issue.key, true);
    await createIssueComment(
      member,
      memberAccess!,
      issue.key,
      "Watcher delivery",
    );
    const watcherEvents = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM outbox_events
        WHERE topic = 'notification.issue_commented'
          AND payload ->> 'issueId' = $1::text
          AND payload ->> 'recipientUserId' = $2::text`,
      [issue.id, viewerId],
    );
    expect(watcherEvents.rows[0]?.count).toBe("1");
    await expect(
      createIssueComment(
        member,
        memberAccess!,
        issue.key,
        "Unknown @outside@example.test",
      ),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "MENTION_NOT_AVAILABLE",
      status: 422,
    });
  });

  it("delivers exactly-once notifications, honors preferences, and dead-letters poison events", async () => {
    const {
      createIssue,
      createIssueComment,
      createProject,
      getPool,
      getProjectAccess,
      listNotifications,
      markNotificationRead,
      processNotificationOutboxBatch,
      setNotificationPreferences,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Notification Test', $2)`,
      [organizationId, `notification-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users
        (id, organization_id, email, display_name, password_hash)
       VALUES
        ($1, $2, 'notify-admin@example.test', 'Notify Admin', 'unused'),
        ($3, $2, 'notify-member@example.test', 'Notify Member', 'unused')`,
      [adminId, organizationId, memberId],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER')`,
      [organizationId, adminId, memberId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: "notify-admin@example.test",
      displayName: "Notify Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: "notify-member@example.test",
      displayName: "Notify Member",
      organizationRole: "MEMBER" as const,
    };
    const project = await createProject(admin, {
      key: "NTF",
      name: "Notification Test",
    });
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER')`,
      [organizationId, project.id, memberId],
    );
    const access = await getProjectAccess(adminId, project.key);
    const issue = await createIssue(admin, access!, {
      summary: "Notification source",
      description: "",
      priority: "MEDIUM",
      issueType: "TASK",
      assigneeId: memberId,
    });
    await createIssueComment(
      admin,
      access!,
      issue.key,
      "Please inspect @notify-member@example.test",
    );

    const firstDelivery = await processNotificationOutboxBatch(100);
    expect(firstDelivery.delivered).toBeGreaterThanOrEqual(1);
    const firstInbox = await listNotifications(member, { limit: 25 });
    expect(firstInbox).toMatchObject({
      unreadCount: 1,
      preferences: { mentions: true, issueComments: true },
      items: [
        {
          eventClass: "MENTION",
          issue: { id: issue.id, key: issue.key, boardId: project.boardId },
          actor: { id: adminId },
        },
      ],
    });
    await processNotificationOutboxBatch(100);
    expect((await listNotifications(member, { limit: 25 })).items).toHaveLength(
      1,
    );

    await markNotificationRead(member, firstInbox.items[0]!.id);
    expect(await listNotifications(member, { limit: 25 })).toMatchObject({
      unreadCount: 0,
      items: [{ readAt: expect.any(String) }],
    });
    await expect(
      markNotificationRead(admin, firstInbox.items[0]!.id),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "NOTIFICATION_NOT_FOUND",
      status: 404,
    });

    await setNotificationPreferences(member, {
      mentions: true,
      issueComments: false,
    });
    await createIssueComment(
      admin,
      access!,
      issue.key,
      "This watched comment is muted by preference",
    );
    const suppressed = await processNotificationOutboxBatch(100);
    expect(suppressed.suppressed).toBeGreaterThanOrEqual(1);
    expect((await listNotifications(member, { limit: 25 })).items).toHaveLength(
      1,
    );

    const poisonId = randomUUID();
    await getPool().query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload)
       VALUES ($1, $2, 'notification.mention', $3, '{}'::jsonb)`,
      [poisonId, organizationId, issue.id],
    );
    const failed = await processNotificationOutboxBatch(100, 2);
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    await getPool().query(
      "UPDATE outbox_events SET available_at = now() WHERE id = $1",
      [poisonId],
    );
    const deadLettered = await processNotificationOutboxBatch(100, 2);
    expect(deadLettered.deadLettered).toBe(1);
    const poison = await getPool().query<{
      attempts: number;
      last_error: string;
      dead_lettered_at: Date | null;
    }>(
      `SELECT attempts, last_error, dead_lettered_at
         FROM outbox_events WHERE id = $1`,
      [poisonId],
    );
    expect(poison.rows[0]).toMatchObject({
      attempts: 2,
      last_error: "Notification payload has an invalid recipientUserId",
      dead_lettered_at: expect.any(Date),
    });
  });

  it("scopes attachment metadata, scan state, removal, and permissions", async () => {
    const {
      createIssue,
      createIssueAttachment,
      createProject,
      deleteIssueAttachment,
      getIssueAttachments,
      getPool,
      getProjectAccess,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    const viewerId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Attachment Test', $2)`,
      [organizationId, `attachment-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users
        (id, organization_id, email, display_name, password_hash)
       VALUES
        ($1, $2, $3, 'Attachment Admin', 'unused'),
        ($4, $2, $5, 'Attachment Member', 'unused'),
        ($6, $2, $7, 'Attachment Viewer', 'unused')`,
      [
        adminId,
        organizationId,
        `${adminId}@example.test`,
        memberId,
        `${memberId}@example.test`,
        viewerId,
        `${viewerId}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER'), ($1, $4, 'MEMBER')`,
      [organizationId, adminId, memberId, viewerId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: `${adminId}@example.test`,
      displayName: "Attachment Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: `${memberId}@example.test`,
      displayName: "Attachment Member",
      organizationRole: "MEMBER" as const,
    };
    const viewer = {
      id: viewerId,
      organizationId,
      email: `${viewerId}@example.test`,
      displayName: "Attachment Viewer",
      organizationRole: "MEMBER" as const,
    };
    const project = await createProject(admin, {
      key: "ATT",
      name: "Attachment Test",
    });
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER'), ($1, $2, $4, 'VIEWER')`,
      [organizationId, project.id, memberId, viewerId],
    );
    const adminAccess = await getProjectAccess(adminId, project.key);
    const memberAccess = await getProjectAccess(memberId, project.key);
    const viewerAccess = await getProjectAccess(viewerId, project.key);
    const issue = await createIssue(admin, adminAccess!, {
      summary: "Attachment source",
      description: "",
      priority: "MEDIUM",
      issueType: "TASK",
    });
    const adminAttachmentId = randomUUID();
    const clean = await createIssueAttachment(admin, adminAccess!, issue.key, {
      id: adminAttachmentId,
      objectKey: `${organizationId}/${adminAttachmentId}`,
      filename: "evidence.txt",
      contentType: "text/plain",
      sizeBytes: 12,
      scanState: "CLEAN",
    });
    expect(clean).toMatchObject({
      id: adminAttachmentId,
      scanState: "CLEAN",
      canDelete: true,
      uploader: { id: adminId },
    });
    expect(await getIssueAttachments(viewer, viewerAccess!, issue.key)).toEqual(
      [expect.objectContaining({ id: adminAttachmentId, canDelete: false })],
    );
    await expect(
      createIssueAttachment(viewer, viewerAccess!, issue.key, {
        id: randomUUID(),
        objectKey: `${organizationId}/${randomUUID()}`,
        filename: "forbidden.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        scanState: "CLEAN",
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });
    await expect(
      deleteIssueAttachment(
        member,
        memberAccess!,
        issue.key,
        adminAttachmentId,
      ),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });
    const rejectedId = randomUUID();
    await createIssueAttachment(member, memberAccess!, issue.key, {
      id: rejectedId,
      objectKey: `${organizationId}/${rejectedId}`,
      filename: "rejected.txt",
      contentType: "text/plain",
      sizeBytes: 68,
      scanState: "REJECTED",
    });
    await deleteIssueAttachment(member, memberAccess!, issue.key, rejectedId);
    await deleteIssueAttachment(
      admin,
      adminAccess!,
      issue.key,
      adminAttachmentId,
    );
    expect(await getIssueAttachments(admin, adminAccess!, issue.key)).toEqual(
      [],
    );
    const writes = await getPool().query<{
      events: string;
      audits: string;
      outbox: string;
    }>(
      `SELECT
        (SELECT count(*) FROM issue_events WHERE issue_id = $1
          AND event_type IN ('ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED')) AS events,
        (SELECT count(*) FROM audit_events WHERE target_id IN ($2, $3)
          AND action IN ('attachment.added', 'attachment.removed')) AS audits,
        (SELECT count(*) FROM outbox_events WHERE aggregate_id IN ($2, $3)
          AND topic IN ('attachment.added', 'attachment.removed')) AS outbox`,
      [issue.id, adminAttachmentId, rejectedId],
    );
    expect(writes.rows[0]).toEqual({ events: "4", audits: "4", outbox: "4" });
  });

  it("searches accessible projects with ranked predicates, stable sorts, and cursors", async () => {
    const {
      createIssue,
      createProject,
      getProjectAccess,
      getPool,
      searchIssues,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Search Test', $2)`,
      [organizationId, `search-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users
        (id, organization_id, email, display_name, password_hash)
       VALUES
        ($1, $2, 'search-admin@example.test', 'Search Admin', 'unused'),
        ($3, $2, 'search-member@example.test', 'Search Member', 'unused')`,
      [adminId, organizationId, memberId],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER')`,
      [organizationId, adminId, memberId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: "search-admin@example.test",
      displayName: "Search Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: "search-member@example.test",
      displayName: "Search Member",
      organizationRole: "MEMBER" as const,
    };
    const projectA = await createProject(admin, {
      key: "SRCA",
      name: "Search Alpha",
    });
    const projectB = await createProject(admin, {
      key: "SRCB",
      name: "Search Beta",
    });
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER')`,
      [organizationId, projectA.id, memberId],
    );
    const accessA = await getProjectAccess(adminId, projectA.key);
    const accessB = await getProjectAccess(adminId, projectB.key);
    const epic = await createIssue(admin, accessA!, {
      summary: "Search parent epic",
      description: "",
      priority: "MEDIUM",
      issueType: "EPIC",
    });
    const summaryMatch = await createIssue(admin, accessA!, {
      summary: "Database timeout release blocker",
      description: "Primary incident",
      priority: "CRITICAL",
      issueType: "BUG",
      assigneeId: memberId,
      labels: ["Customer Request", "Urgent"],
      parentIssueKey: epic.key,
    });
    const descriptionMatch = await createIssue(admin, accessB!, {
      summary: "Operational handbook",
      description: "Resolve database timeout during deployment",
      priority: "LOW",
      issueType: "TASK",
      labels: ["Documentation"],
    });

    const ranked = await searchIssues(admin, {
      q: "database timeout",
      projects: [],
      issueTypes: [],
      statuses: [],
      statusCategories: [],
      priorities: [],
      assignees: [],
      reporters: [],
      labels: [],
      parents: [],
      sort: "relevance",
      limit: 25,
    });
    expect(ranked.items.map((issue) => issue.id)).toEqual([
      summaryMatch.id,
      descriptionMatch.id,
    ]);
    expect(ranked.items[0]!.relevance).toBeGreaterThan(
      ranked.items[1]!.relevance,
    );

    const filtered = await searchIssues(admin, {
      q: "",
      projects: [projectA.key],
      issueTypes: ["BUG", "TASK"],
      statuses: [],
      statusCategories: ["TODO"],
      priorities: ["CRITICAL", "HIGH"],
      assignees: [memberId],
      reporters: [adminId],
      labels: ["customer request"],
      parents: [epic.key],
      createdFrom: "2026-01-01",
      createdTo: "2026-12-31",
      updatedFrom: "2026-01-01",
      updatedTo: "2026-12-31",
      sort: "priority",
      direction: "desc",
      limit: 25,
    });
    expect(filtered.items.map((issue) => issue.id)).toEqual([summaryMatch.id]);

    const memberResults = await searchIssues(member, {
      q: "database timeout",
      projects: [],
      issueTypes: [],
      statuses: [],
      statusCategories: [],
      priorities: [],
      assignees: [],
      reporters: [],
      labels: [],
      parents: [],
      sort: "relevance",
      limit: 25,
    });
    expect(memberResults.items.map((issue) => issue.id)).toEqual([
      summaryMatch.id,
    ]);
    expect(memberResults.facets.projects.map((project) => project.key)).toEqual(
      [projectA.key],
    );

    const firstPage = await searchIssues(admin, {
      q: "database timeout",
      projects: [],
      issueTypes: [],
      statuses: [],
      statusCategories: [],
      priorities: [],
      assignees: [],
      reporters: [],
      labels: [],
      parents: [],
      sort: "key",
      direction: "asc",
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await searchIssues(admin, {
      q: "database timeout",
      projects: [],
      issueTypes: [],
      statuses: [],
      statusCategories: [],
      priorities: [],
      assignees: [],
      reporters: [],
      labels: [],
      parents: [],
      sort: "key",
      direction: "asc",
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect([firstPage.items[0]!.id, secondPage.items[0]!.id]).toEqual([
      summaryMatch.id,
      descriptionMatch.id,
    ]);

    const otherOrganizationId = randomUUID();
    const otherAdminId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Other Search', $2)`,
      [otherOrganizationId, `other-search-${otherOrganizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, 'other-search@example.test', 'Other Search', 'unused')`,
      [otherAdminId, otherOrganizationId],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')`,
      [otherOrganizationId, otherAdminId],
    );
    const otherAdmin = {
      id: otherAdminId,
      organizationId: otherOrganizationId,
      email: "other-search@example.test",
      displayName: "Other Search",
      organizationRole: "ADMIN" as const,
    };
    const otherProject = await createProject(otherAdmin, {
      key: "OTH",
      name: "Other Search",
    });
    const otherAccess = await getProjectAccess(otherAdminId, otherProject.key);
    await createIssue(otherAdmin, otherAccess!, {
      summary: "Database timeout secret",
      description: "",
      priority: "CRITICAL",
      issueType: "BUG",
    });
    const isolated = await searchIssues(admin, {
      q: "database timeout",
      projects: [],
      issueTypes: [],
      statuses: [],
      statusCategories: [],
      priorities: [],
      assignees: [],
      reporters: [],
      labels: [],
      parents: [],
      sort: "relevance",
      limit: 25,
    });
    expect(isolated.items.map((issue) => issue.id)).toEqual([
      summaryMatch.id,
      descriptionMatch.id,
    ]);
  });

  it("shares saved filters by scope and projects compatible quick filters onto boards", async () => {
    const {
      createProject,
      createSavedFilter,
      deleteSavedFilter,
      getProjectAccess,
      getSavedFilter,
      getPool,
      listBoardQuickFilters,
      listSavedFilters,
      updateSavedFilter,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    const viewerId = randomUUID();
    const outsiderId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Saved Filter Test', $2)`,
      [organizationId, `saved-filter-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users
        (id, organization_id, email, display_name, password_hash)
       VALUES
        ($1, $2, 'filter-admin@example.test', 'Filter Admin', 'unused'),
        ($3, $2, 'filter-member@example.test', 'Filter Member', 'unused'),
        ($4, $2, 'filter-viewer@example.test', 'Filter Viewer', 'unused'),
        ($5, $2, 'filter-outsider@example.test', 'Filter Outsider', 'unused')`,
      [adminId, organizationId, memberId, viewerId, outsiderId],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER'),
              ($1, $4, 'MEMBER'), ($1, $5, 'MEMBER')`,
      [organizationId, adminId, memberId, viewerId, outsiderId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: "filter-admin@example.test",
      displayName: "Filter Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: "filter-member@example.test",
      displayName: "Filter Member",
      organizationRole: "MEMBER" as const,
    };
    const viewer = {
      id: viewerId,
      organizationId,
      email: "filter-viewer@example.test",
      displayName: "Filter Viewer",
      organizationRole: "MEMBER" as const,
    };
    const outsider = {
      id: outsiderId,
      organizationId,
      email: "filter-outsider@example.test",
      displayName: "Filter Outsider",
      organizationRole: "MEMBER" as const,
    };
    const project = await createProject(admin, {
      key: "FLT",
      name: "Saved Filter Test",
    });
    const otherProject = await createProject(admin, {
      key: "FLTO",
      name: "Other Filter Test",
    });
    await getPool().query(
      `INSERT INTO project_members (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER'), ($1, $2, $4, 'VIEWER'),
              ($1, $5, $6, 'MEMBER')`,
      [
        organizationId,
        project.id,
        memberId,
        viewerId,
        otherProject.id,
        outsiderId,
      ],
    );
    const query = {
      q: "release",
      projects: [],
      issueTypes: ["BUG"],
      statuses: [],
      statusCategories: [],
      priorities: ["CRITICAL"],
      assignees: ["unassigned"],
      reporters: [],
      labels: ["urgent"],
      parents: [],
      sort: "priority",
      limit: 25,
    } satisfies IssueSearchQuery;
    const privateFilter = await createSavedFilter(member, {
      name: "My release bugs",
      visibility: "PRIVATE",
      projectKey: project.key,
      query,
      isQuick: false,
    });
    const adminPrivate = await createSavedFilter(admin, {
      name: "Admin private",
      visibility: "PRIVATE",
      projectKey: null,
      query,
      isQuick: false,
    });
    const projectQuick = await createSavedFilter(admin, {
      name: "Critical release bugs",
      visibility: "PROJECT",
      projectKey: project.key,
      query,
      isQuick: true,
    });
    const organizationFilter = await createSavedFilter(admin, {
      name: "Organization releases",
      visibility: "ORGANIZATION",
      projectKey: null,
      query,
      isQuick: false,
    });
    expect(privateFilter).toMatchObject({
      visibility: "PRIVATE",
      canEdit: true,
    });
    expect(projectQuick).toMatchObject({
      visibility: "PROJECT",
      isQuick: true,
      position: 0,
      query: { projects: [project.key] },
    });

    expect((await listSavedFilters(member)).map((item) => item.id)).toEqual(
      expect.arrayContaining([
        privateFilter.id,
        projectQuick.id,
        organizationFilter.id,
      ]),
    );
    expect(
      (await listSavedFilters(member)).map((item) => item.id),
    ).not.toContain(adminPrivate.id);
    expect((await listSavedFilters(viewer)).map((item) => item.id)).toEqual(
      expect.arrayContaining([projectQuick.id, organizationFilter.id]),
    );
    expect((await listSavedFilters(outsider)).map((item) => item.id)).toEqual([
      organizationFilter.id,
    ]);
    expect(await getSavedFilter(outsider, projectQuick.id)).toBeNull();

    const viewerAccess = await getProjectAccess(viewerId, project.key);
    expect(await listBoardQuickFilters(viewer, viewerAccess!)).toEqual([
      {
        id: projectQuick.id,
        name: "Critical release bugs",
        query: {
          q: "release",
          issueType: "BUG",
          priority: "CRITICAL",
          assignee: "unassigned",
          label: "urgent",
          epicKey: "",
        },
      },
    ]);
    await expect(
      createSavedFilter(member, {
        name: "Member cannot share",
        visibility: "PROJECT",
        projectKey: project.key,
        query,
        isQuick: true,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });
    await expect(
      createSavedFilter(admin, {
        name: "Unsupported quick filter",
        visibility: "PROJECT",
        projectKey: project.key,
        query: {
          ...query,
          statusCategories: ["TODO"],
        },
        isQuick: true,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "QUICK_FILTER_UNSUPPORTED",
      status: 422,
    });

    const renamed = await updateSavedFilter(admin, projectQuick.id, {
      name: "Renamed quick filter",
      visibility: "PROJECT",
      projectKey: project.key,
      query,
      isQuick: true,
      version: projectQuick.version,
    });
    expect(renamed).toMatchObject({ name: "Renamed quick filter", version: 2 });
    await expect(
      updateSavedFilter(admin, projectQuick.id, {
        name: "Stale rename",
        visibility: "PROJECT",
        projectKey: project.key,
        query,
        isQuick: true,
        version: projectQuick.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "VERSION_CONFLICT",
      status: 409,
    });
    await expect(
      updateSavedFilter(viewer, projectQuick.id, {
        name: "Viewer rename",
        visibility: "PROJECT",
        projectKey: project.key,
        query,
        isQuick: true,
        version: renamed.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });
    await deleteSavedFilter(member, privateFilter.id, privateFilter.version);
    expect(await getSavedFilter(member, privateFilter.id)).toBeNull();

    const writes = await getPool().query<{
      audit_count: string;
      outbox_count: string;
    }>(
      `SELECT
        (SELECT count(*) FROM audit_events
          WHERE target_type = 'saved_filter' AND target_id = $1) AS audit_count,
        (SELECT count(*) FROM outbox_events
          WHERE aggregate_id = $1 AND topic LIKE 'filter.%') AS outbox_count`,
      [projectQuick.id],
    );
    expect(writes.rows[0]).toEqual({ audit_count: "2", outbox_count: "2" });
  });

  it("delivers general outbox events exactly once and exposes retryable health", async () => {
    const {
      getOutboxHealth,
      getPool,
      processGeneralOutboxBatch,
      recordWorkerHeartbeat,
      retryOutboxEvent,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Outbox Test', $2)`,
      [organizationId, `outbox-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users
        (id, organization_id, email, display_name, password_hash)
       VALUES
        ($1, $2, 'outbox-admin@example.test', 'Outbox Admin', 'unused'),
        ($3, $2, 'outbox-member@example.test', 'Outbox Member', 'unused')`,
      [adminId, organizationId, memberId],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER')`,
      [organizationId, adminId, memberId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: "outbox-admin@example.test",
      displayName: "Outbox Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: "outbox-member@example.test",
      displayName: "Outbox Member",
      organizationRole: "MEMBER" as const,
    };
    const eventIds = [randomUUID(), randomUUID()];
    await getPool().query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload, created_at, available_at)
       VALUES
        ($1, $2, 'data_job.created', $3, '{"value":1}',
         now() - interval '30 years', now() - interval '30 years'),
        ($4, $2, 'test.second', $5, '{"value":2}',
         now() - interval '29 years', now() - interval '29 years')`,
      [eventIds[0], organizationId, randomUUID(), eventIds[1], randomUUID()],
    );
    await Promise.all([
      processGeneralOutboxBatch(1, 2),
      processGeneralOutboxBatch(1, 2),
    ]);
    const delivered = await getPool().query<{
      source_outbox_id: string;
      attempts: number;
    }>(
      `SELECT d.source_outbox_id, o.attempts
         FROM outbox_deliveries d
         JOIN outbox_events o ON o.id = d.source_outbox_id
        WHERE d.source_outbox_id = ANY($1::uuid[])
        ORDER BY d.source_outbox_id`,
      [eventIds],
    );
    expect(delivered.rows).toHaveLength(2);
    expect(delivered.rows.every((row) => row.attempts === 1)).toBe(true);

    await getPool().query(
      `UPDATE outbox_events
          SET published_at = NULL, available_at = now() - interval '28 years'
        WHERE id = $1`,
      [eventIds[0]],
    );
    const replay = await processGeneralOutboxBatch(1, 2);
    expect(replay).toMatchObject({ processed: 1, delivered: 0, replayed: 1 });
    const deduplicated = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM outbox_deliveries WHERE source_outbox_id = $1`,
      [eventIds[0]],
    );
    expect(deduplicated.rows[0]?.count).toBe("1");

    const poisonId = randomUUID();
    await getPool().query(
      `INSERT INTO outbox_events
        (id, organization_id, topic, aggregate_id, payload, created_at, available_at)
       VALUES ($1, $2, 'test.poison', $3, '"invalid"'::jsonb,
               now() - interval '40 years', now() - interval '40 years')`,
      [poisonId, organizationId, randomUUID()],
    );
    expect(await processGeneralOutboxBatch(1, 2)).toMatchObject({ failed: 1 });
    await getPool().query(
      `UPDATE outbox_events
          SET available_at = now() - interval '40 years'
        WHERE id = $1`,
      [poisonId],
    );
    expect(await processGeneralOutboxBatch(1, 2)).toMatchObject({
      failed: 1,
      deadLettered: 1,
    });

    await recordWorkerHeartbeat("outbox", "integration-worker");
    const health = await getOutboxHealth(admin);
    expect(health).toMatchObject({
      worker: { state: "HEALTHY", instanceId: "integration-worker" },
      deadLettered: 1,
    });
    expect(health.deadLetters[0]).toMatchObject({
      id: poisonId,
      topic: "test.poison",
      attempts: 2,
    });
    await expect(getOutboxHealth(member)).rejects.toMatchObject<
      Partial<DomainError>
    >({ code: "FORBIDDEN", status: 403 });

    await retryOutboxEvent(admin, poisonId, randomUUID());
    const retried = await getPool().query<{
      attempts: number;
      dead_lettered_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT attempts, dead_lettered_at, last_error
         FROM outbox_events WHERE id = $1`,
      [poisonId],
    );
    expect(retried.rows[0]).toEqual({
      attempts: 0,
      dead_lettered_at: null,
      last_error: null,
    });
    const retryAudit = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM audit_events
        WHERE organization_id = $1 AND action = 'outbox.retried'
          AND target_id = $2`,
      [organizationId, poisonId],
    );
    expect(retryAudit.rows[0]?.count).toBe("1");
  });

  it("queries correlated audit evidence and enforces versioned retention", async () => {
    const {
      getAuditEvents,
      getPool,
      pruneExpiredAuditEvents,
      updateAuditRetention,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Audit Test', $2)`,
      [organizationId, `audit-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $3, $4, 'Audit Admin', 'unused'),
              ($2, $3, $5, 'Audit Member', 'unused')`,
      [
        adminId,
        memberId,
        organizationId,
        `${adminId}@example.test`,
        `${memberId}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER')`,
      [organizationId, adminId, memberId],
    );
    const targetId = randomUUID();
    const correlationId = randomUUID();
    await getPool().query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id, created_at)
       VALUES ($1, $3, $4, 'issue.created', 'issue', $5,
               '{"summary":"Audited"}', $6, now()),
              ($2, $3, $4, 'project.created', 'project', $7,
               '{}'::jsonb, $8, now() - interval '1 second')`,
      [
        randomUUID(),
        randomUUID(),
        organizationId,
        adminId,
        targetId,
        correlationId,
        randomUUID(),
        randomUUID(),
      ],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: `${adminId}@example.test`,
      displayName: "Audit Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: `${memberId}@example.test`,
      displayName: "Audit Member",
      organizationRole: "MEMBER" as const,
    };

    const firstPage = await getAuditEvents(admin, { limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.facets.actions).toContain("issue.created");
    const secondPage = await getAuditEvents(admin, {
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items).toHaveLength(1);
    const today = new Date().toISOString().slice(0, 10);
    const filtered = await getAuditEvents(admin, {
      limit: 50,
      actorId: adminId,
      action: "issue",
      targetType: "issue",
      targetId,
      correlationId,
      from: today,
      to: today,
    });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({
      action: "issue.created",
      targetId,
      correlationId,
      metadata: { summary: "Audited" },
    });
    await expect(getAuditEvents(member, { limit: 50 })).rejects.toMatchObject<
      Partial<DomainError>
    >({ code: "FORBIDDEN", status: 403 });

    const retention = await updateAuditRetention(
      admin,
      30,
      firstPage.retention.version,
      randomUUID(),
    );
    expect(retention).toEqual({ days: 30, version: 2 });
    await expect(
      updateAuditRetention(admin, 90, firstPage.retention.version),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "VERSION_CONFLICT",
      status: 409,
    });
    await getPool().query(
      `INSERT INTO audit_events
        (id, organization_id, actor_id, action, target_type, target_id,
         metadata, correlation_id, created_at)
       VALUES ($1, $2, $3, 'expired.test', 'issue', $4, '{}'::jsonb, $5,
               now() - interval '31 days')`,
      [randomUUID(), organizationId, adminId, randomUUID(), randomUUID()],
    );
    expect(await pruneExpiredAuditEvents()).toBeGreaterThanOrEqual(1);
    const expired = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM audit_events
        WHERE organization_id = $1 AND action = 'expired.test'`,
      [organizationId],
    );
    expect(expired.rows[0]?.count).toBe("0");
    const evidence = await getPool().query<{ audit: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM audit_events
           WHERE organization_id = $1 AND action = 'audit.retention_updated') AS audit,
         (SELECT count(*) FROM outbox_events
           WHERE organization_id = $1 AND topic = 'audit.retention_updated') AS outbox`,
      [organizationId],
    );
    expect(evidence.rows[0]).toEqual({ audit: "1", outbox: "1" });
  });

  it("administers organization users, project lifecycle, boards, and templates", async () => {
    const {
      createIssue,
      createProject,
      getAdministrationSettings,
      getBoardAccess,
      getPool,
      listProjects,
      updateAdminProject,
      updateOrganizationSettings,
      updateOrganizationUser,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const secondAdminId = randomUUID();
    const memberId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Administration Test', $2)`,
      [organizationId, `administration-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $4, $5, 'Primary Admin', 'unused'),
              ($2, $4, $6, 'Second Admin', 'unused'),
              ($3, $4, $7, 'Assigned Member', 'unused')`,
      [
        adminId,
        secondAdminId,
        memberId,
        organizationId,
        `${adminId}@example.test`,
        `${secondAdminId}@example.test`,
        `${memberId}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'ADMIN'), ($1, $4, 'MEMBER')`,
      [organizationId, adminId, secondAdminId, memberId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: `${adminId}@example.test`,
      displayName: "Primary Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: `${memberId}@example.test`,
      displayName: "Assigned Member",
      organizationRole: "MEMBER" as const,
    };
    const project = await createProject(admin, {
      key: "SMP",
      name: "Simple Project",
      template: "SIMPLE",
    });
    const statusCount = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM statuses s JOIN workflows w ON w.id = s.workflow_id
        WHERE w.project_id = $1`,
      [project.id],
    );
    expect(statusCount.rows[0]?.count).toBe("3");
    const initial = await getAdministrationSettings(admin);
    expect(initial.organization.name).toBe("Administration Test");
    expect(initial.projects[0]).toMatchObject({
      key: "SMP",
      archived: false,
    });
    await expect(getAdministrationSettings(member)).rejects.toMatchObject<
      Partial<DomainError>
    >({ code: "FORBIDDEN", status: 403 });

    await updateOrganizationSettings(admin, {
      name: "Administration Renamed",
      version: initial.organization.version,
    });
    await expect(
      updateOrganizationSettings(admin, {
        name: "Stale",
        version: initial.organization.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "VERSION_CONFLICT",
      status: 409,
    });

    const secondAdmin = initial.users.find(
      (user) => user.id === secondAdminId,
    )!;
    await updateOrganizationUser(admin, secondAdminId, {
      state: "ACTIVE",
      organizationRole: "MEMBER",
      version: secondAdmin.version,
    });
    const afterDemotion = await getAdministrationSettings(admin);
    const primary = afterDemotion.users.find((user) => user.id === adminId)!;
    await expect(
      updateOrganizationUser(admin, adminId, {
        state: "ACTIVE",
        organizationRole: "MEMBER",
        version: primary.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "LAST_ORGANIZATION_ADMIN",
      status: 409,
    });
    const secondAdminAfterDemotion = afterDemotion.users.find(
      (user) => user.id === secondAdminId,
    )!;
    await updateOrganizationUser(admin, secondAdminId, {
      state: "INACTIVE",
      organizationRole: "MEMBER",
      version: secondAdminAfterDemotion.version,
    });
    const afterDeactivation = await getAdministrationSettings(admin);
    const inactiveUser = afterDeactivation.users.find(
      (user) => user.id === secondAdminId,
    )!;
    await updateOrganizationUser(admin, secondAdminId, {
      state: "ACTIVE",
      organizationRole: "MEMBER",
      version: inactiveUser.version,
    });

    await getPool().query(
      `INSERT INTO project_members
        (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER')`,
      [organizationId, project.id, memberId],
    );
    const access = await getBoardAccess(adminId, project.boardId);
    await createIssue(admin, access!, {
      summary: "Assigned administration work",
      description: "",
      priority: "MEDIUM",
      issueType: "TASK",
      assigneeId: memberId,
    });
    const withAssignment = await getAdministrationSettings(admin);
    const assignedMember = withAssignment.users.find(
      (user) => user.id === memberId,
    )!;
    expect(assignedMember.activeAssignments).toBe(1);
    await expect(
      updateOrganizationUser(admin, memberId, {
        state: "INACTIVE",
        organizationRole: "MEMBER",
        version: assignedMember.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "USER_HAS_ACTIVE_ASSIGNMENTS",
      status: 409,
    });

    const projectSettings = withAssignment.projects.find(
      (item) => item.id === project.id,
    )!;
    await updateAdminProject(admin, project.id, {
      name: "Simple Renamed",
      boardName: "Requests board",
      archived: true,
      version: projectSettings.version,
      boardVersion: projectSettings.board.version,
    });
    expect(await listProjects(admin)).toHaveLength(0);
    const archived = await getAdministrationSettings(admin);
    const archivedProject = archived.projects.find(
      (item) => item.id === project.id,
    )!;
    expect(archivedProject).toMatchObject({
      name: "Simple Renamed",
      board: { name: "Requests board" },
      archived: true,
    });
    await expect(
      updateAdminProject(admin, project.id, {
        name: "Stale",
        boardName: "Stale",
        archived: false,
        version: projectSettings.version,
        boardVersion: projectSettings.board.version,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "VERSION_CONFLICT",
      status: 409,
    });
    await updateAdminProject(admin, project.id, {
      name: archivedProject.name,
      boardName: archivedProject.board.name,
      archived: false,
      version: archivedProject.version,
      boardVersion: archivedProject.board.version,
    });
    expect((await listProjects(admin))[0]?.key).toBe("SMP");

    const evidence = await getPool().query<{ audit: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM audit_events WHERE organization_id = $1
            AND action IN ('organization.updated', 'user.updated',
                           'project.archived', 'project.restored')) AS audit,
         (SELECT count(*) FROM outbox_events WHERE organization_id = $1
            AND topic IN ('organization.updated', 'user.updated',
                          'project.archived', 'project.restored')) AS outbox`,
      [organizationId],
    );
    expect(Number(evidence.rows[0]?.audit)).toBeGreaterThanOrEqual(5);
    expect(evidence.rows[0]?.outbox).toBe(evidence.rows[0]?.audit);
  });

  it("invites, activates, and rate-limits identities without losing attribution", async () => {
    const {
      acceptUserInvitation,
      consumeRateLimit,
      getAdministrationSettings,
      getIdentity,
      getPool,
      inviteOrganizationUser,
      updateOrganizationUser,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Identity Test', $2)`,
      [organizationId, `identity-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Identity Admin', 'unused')`,
      [adminId, organizationId, `${adminId}@example.test`],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')`,
      [organizationId, adminId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: `${adminId}@example.test`,
      displayName: "Identity Admin",
      organizationRole: "ADMIN" as const,
    };
    const invited = await inviteOrganizationUser(
      admin,
      {
        email: `invited-${organizationId}@example.test`,
        displayName: "Invited User",
        organizationRole: "MEMBER",
      },
      "https://vibe.example.test",
    );
    expect(invited.activationUrl).toMatch(
      /^https:\/\/vibe\.example\.test\/invite\/[A-Za-z0-9_-]+$/,
    );
    const token = invited.activationUrl.split("/").at(-1)!;
    const pending = (await getAdministrationSettings(admin)).users.find(
      (user) => user.displayName === "Invited User",
    )!;
    expect(pending.state).toBe("INVITED");
    expect(await getIdentity(pending.id)).toBeNull();
    expect(await acceptUserInvitation(token, "invitation-password-123")).toBe(
      pending.id,
    );
    expect(await getIdentity(pending.id)).toMatchObject({
      id: pending.id,
      organizationRole: "MEMBER",
    });
    await expect(
      acceptUserInvitation(token, "invitation-password-123"),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "INVITATION_INVALID",
      status: 410,
    });
    const active = (await getAdministrationSettings(admin)).users.find(
      (user) => user.id === pending.id,
    )!;
    await updateOrganizationUser(admin, active.id, {
      state: "INACTIVE",
      organizationRole: "MEMBER",
      version: active.version,
    });
    expect(await getIdentity(active.id)).toBeNull();
    const attributed = await getPool().query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_events
        WHERE organization_id = $1 AND actor_id = $2
          AND action = 'user.activated'`,
      [organizationId, active.id],
    );
    expect(attributed.rows[0]?.count).toBe("1");

    expect(await consumeRateLimit("test", organizationId, 2, 60)).toMatchObject(
      { allowed: true, remaining: 1 },
    );
    expect(await consumeRateLimit("test", organizationId, 2, 60)).toMatchObject(
      { allowed: true, remaining: 0 },
    );
    expect(await consumeRateLimit("test", organizationId, 2, 60)).toMatchObject(
      { allowed: false, remaining: 0 },
    );
  });

  it("resolves effective project roles through organization teams", async () => {
    const {
      createProject,
      createTeam,
      getAdministrationTeams,
      getProjectAccess,
      getProjectTeams,
      getPool,
      listProjects,
      setProjectTeam,
      updateTeam,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Team Test', $2)`,
      [organizationId, `teams-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $3, $4, 'Team Admin', 'unused'),
              ($2, $3, $5, 'Team Member', 'unused')`,
      [
        adminId,
        memberId,
        organizationId,
        `${adminId}@example.test`,
        `${memberId}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER')`,
      [organizationId, adminId, memberId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: `${adminId}@example.test`,
      displayName: "Team Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: `${memberId}@example.test`,
      displayName: "Team Member",
      organizationRole: "MEMBER" as const,
    };
    const project = await createProject(admin, { key: "TEM", name: "Teams" });
    await createTeam(admin, "Developers");
    let teams = await getAdministrationTeams(admin);
    const team = teams.teams.find((item) => item.name === "Developers")!;
    await updateTeam(admin, team.id, {
      name: team.name,
      memberIds: [memberId],
      version: team.version,
    });
    const adminAccess = await getProjectAccess(adminId, project.key);
    await setProjectTeam(admin, adminAccess!, team.id, "MEMBER");
    expect(await getProjectAccess(memberId, project.key)).toMatchObject({
      projectRole: "MEMBER",
    });
    expect((await listProjects(member)).map((item) => item.key)).toContain(
      "TEM",
    );
    expect((await getProjectTeams(admin, adminAccess!)).teams[0]).toMatchObject(
      {
        name: "Developers",
        memberCount: 1,
        projectRole: "MEMBER",
      },
    );

    teams = await getAdministrationTeams(admin);
    const changedTeam = teams.teams.find((item) => item.id === team.id)!;
    await updateTeam(admin, team.id, {
      name: "Platform developers",
      memberIds: [],
      version: changedTeam.version,
    });
    expect(
      (await getProjectAccess(memberId, project.key))?.projectRole,
    ).toBeNull();
    await setProjectTeam(admin, adminAccess!, team.id, null);
    const evidence = await getPool().query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_events
        WHERE organization_id = $1 AND target_id = $2
          AND action IN ('team.created', 'team.updated',
                         'project.team_role_changed', 'project.team_removed')`,
      [organizationId, team.id],
    );
    expect(evidence.rows[0]?.count).toBe("5");
  });

  it("runs idempotent CSV import and export jobs with explicit invalid-row policy", async () => {
    const {
      createDataJob,
      createProject,
      getBoardAccess,
      getDataJobDownload,
      getDataJobs,
      getPool,
      processDataJobBatch,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Data Job Test', $2)`,
      [organizationId, `data-job-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $3, $4, 'Data Admin', 'unused'),
              ($2, $3, $5, 'Data Member', 'unused')`,
      [
        adminId,
        memberId,
        organizationId,
        `${adminId}@example.test`,
        `${memberId}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER')`,
      [organizationId, adminId, memberId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: `${adminId}@example.test`,
      displayName: "Data Admin",
      organizationRole: "ADMIN" as const,
    };
    const member = {
      id: memberId,
      organizationId,
      email: `${memberId}@example.test`,
      displayName: "Data Member",
      organizationRole: "MEMBER" as const,
    };
    const project = await createProject(admin, {
      key: "CSV",
      name: "CSV Project",
    });
    await getPool().query(
      `INSERT INTO project_members
        (organization_id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'MEMBER')`,
      [organizationId, project.id, memberId],
    );
    const access = await getBoardAccess(adminId, project.boardId);
    const memberAccess = await getBoardAccess(memberId, project.boardId);
    const csv = [
      "Summary,Description,Issue Type,Priority,Labels",
      "Imported release,From integration,Bug,HIGH,import|release",
      "Invalid row,,Subtask,MEDIUM,",
    ].join("\n");
    await expect(
      createDataJob(
        admin,
        access!,
        { jobType: "CSV_IMPORT", csv, invalidRowPolicy: "ATOMIC" },
        "atomic-import-1",
      ),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "CSV_VALIDATION_FAILED",
      status: 422,
    });
    const queued = await createDataJob(
      admin,
      access!,
      { jobType: "CSV_IMPORT", csv, invalidRowPolicy: "SKIP_INVALID" },
      "skip-import-1",
    );
    expect(queued.state).toBe("QUEUED");
    expect(
      (
        await createDataJob(
          admin,
          access!,
          { jobType: "CSV_IMPORT", csv, invalidRowPolicy: "SKIP_INVALID" },
          "skip-import-1",
        )
      ).id,
    ).toBe(queued.id);
    await expect(
      createDataJob(
        admin,
        access!,
        {
          jobType: "CSV_IMPORT",
          csv: csv.replace("Imported release", "Different request"),
          invalidRowPolicy: "SKIP_INVALID",
        },
        "skip-import-1",
      ),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });
    await expect(
      createDataJob(
        member,
        memberAccess!,
        { jobType: "CSV_EXPORT" },
        "member-export-1",
      ),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });
    const importResults = await Promise.all([
      processDataJobBatch(1),
      processDataJobBatch(1),
    ]);
    expect(
      importResults.reduce((total, result) => total + result.processed, 0),
    ).toBe(1);
    const afterImport = await getDataJobs(admin, access!);
    expect(afterImport.jobs[0]).toMatchObject({
      id: queued.id,
      state: "SUCCEEDED",
      result: { imported: 1, skipped: 1 },
    });
    const imported = await getPool().query<{ summary: string }>(
      `SELECT summary FROM issues WHERE project_id = $1`,
      [project.id],
    );
    expect(imported.rows).toEqual([{ summary: "Imported release" }]);

    const exportJob = await createDataJob(
      admin,
      access!,
      { jobType: "CSV_EXPORT" },
      "export-job-1",
    );
    expect(await processDataJobBatch(5)).toMatchObject({ processed: 1 });
    const output = await getDataJobDownload(admin, access!, exportJob.id);
    expect(output).toContain("Key,Summary,Description,Issue Type");
    expect(output).toContain("Imported release");
    await expect(
      getDataJobDownload(member, memberAccess!, exportJob.id),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });
    const evidence = await getPool().query<{ audit: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM audit_events WHERE organization_id = $1
            AND action IN ('data_job.created', 'data_job.succeeded')) AS audit,
         (SELECT count(*) FROM outbox_events WHERE organization_id = $1
            AND topic IN ('data_job.created', 'data_job.succeeded')) AS outbox`,
      [organizationId],
    );
    expect(evidence.rows[0]).toEqual({ audit: "4", outbox: "4" });
  });

  it("reproduces published Kanban metrics from deterministic event history", async () => {
    const {
      createIssue,
      createProject,
      getBoard,
      getBoardAccess,
      getKanbanReports,
      getPool,
      transitionIssue,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const adminId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Metrics Test', $2)`,
      [organizationId, `metrics-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Metrics Admin', 'unused')`,
      [adminId, organizationId, `${adminId}@example.test`],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')`,
      [organizationId, adminId],
    );
    const admin = {
      id: adminId,
      organizationId,
      email: `${adminId}@example.test`,
      displayName: "Metrics Admin",
      organizationRole: "ADMIN" as const,
    };
    const project = await createProject(admin, { key: "MET", name: "Metrics" });
    const access = await getBoardAccess(adminId, project.boardId);
    const board = await getBoard(project.boardId, access!);
    const first = await createIssue(admin, access!, {
      summary: "Completed fixture",
      description: "",
      priority: "MEDIUM",
      issueType: "TASK",
    });
    const inProgressStatus = board!.statuses.find(
      (status) => status.name === "In Progress",
    )!;
    const reviewStatus = board!.statuses.find(
      (status) => status.name === "Review",
    )!;
    const doneStatus = board!.statuses.find(
      (status) => status.name === "Done",
    )!;
    const inProgressColumn = board!.columns.find((column) =>
      column.statusIds.includes(inProgressStatus.id),
    )!;
    const doneColumn = board!.columns.find((column) =>
      column.statusIds.includes(doneStatus.id),
    )!;
    let current = await transitionIssue(admin, access!, first.key, {
      transitionId: first.allowedTransitions.find(
        (transition) => transition.toStatusId === inProgressStatus.id,
      )!.id,
      destinationColumnId: inProgressColumn.id,
      destinationStatusId: inProgressStatus.id,
      beforeIssueId: null,
      afterIssueId: null,
      version: first.version,
    });
    current = await transitionIssue(admin, access!, first.key, {
      transitionId: current.allowedTransitions.find(
        (transition) => transition.toStatusId === reviewStatus.id,
      )!.id,
      destinationColumnId: inProgressColumn.id,
      destinationStatusId: reviewStatus.id,
      beforeIssueId: null,
      afterIssueId: null,
      version: current.version,
    });
    await transitionIssue(admin, access!, first.key, {
      transitionId: current.allowedTransitions.find(
        (transition) => transition.toStatusId === doneStatus.id,
      )!.id,
      destinationColumnId: doneColumn.id,
      destinationStatusId: doneStatus.id,
      beforeIssueId: null,
      afterIssueId: null,
      version: current.version,
    });
    const second = await createIssue(admin, access!, {
      summary: "Aging fixture",
      description: "",
      priority: "HIGH",
      issueType: "BUG",
    });
    await transitionIssue(admin, access!, second.key, {
      transitionId: second.allowedTransitions.find(
        (transition) => transition.toStatusId === inProgressStatus.id,
      )!.id,
      destinationColumnId: inProgressColumn.id,
      destinationStatusId: inProgressStatus.id,
      beforeIssueId: null,
      afterIssueId: null,
      version: second.version,
    });
    await getPool().query(
      `UPDATE issues SET created_at = CASE id
          WHEN $1 THEN '2026-01-01T00:00:00Z'::timestamptz
          WHEN $2 THEN '2026-01-02T00:00:00Z'::timestamptz END
        WHERE id = ANY($3::uuid[])`,
      [first.id, second.id, [first.id, second.id]],
    );
    const firstEvents = await getPool().query<{
      id: string;
      event_type: string;
    }>(
      `SELECT id, event_type FROM issue_events WHERE issue_id = $1
        ORDER BY created_at, id`,
      [first.id],
    );
    const firstTimes = [
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      "2026-01-03T00:00:00Z",
      "2026-01-04T00:00:00Z",
    ];
    for (const [index, event] of firstEvents.rows.entries()) {
      await getPool().query(
        `UPDATE issue_events SET created_at = $1 WHERE id = $2`,
        [firstTimes[index], event.id],
      );
    }
    const secondEvents = await getPool().query<{ id: string }>(
      `SELECT id FROM issue_events WHERE issue_id = $1 ORDER BY created_at, id`,
      [second.id],
    );
    for (const [index, event] of secondEvents.rows.entries()) {
      await getPool().query(
        `UPDATE issue_events SET created_at = $1 WHERE id = $2`,
        [
          index === 0 ? "2026-01-02T00:00:00Z" : "2026-01-03T00:00:00Z",
          event.id,
        ],
      );
    }

    const report = await getKanbanReports(admin, access!, {
      from: "2026-01-01",
      to: "2026-01-05",
    });
    expect(report.summary).toMatchObject({
      throughput: 1,
      averageLeadTimeSeconds: 3 * 86_400,
      averageCycleTimeSeconds: 2 * 86_400,
      activeWip: 1,
    });
    expect(
      report.throughput.find((point) => point.date === "2026-01-04"),
    ).toEqual({ date: "2026-01-04", count: 1 });
    expect(
      report.createdResolved.find((point) => point.date === "2026-01-02"),
    ).toEqual({ date: "2026-01-02", created: 1, resolved: 0 });
    expect(report.cumulativeFlow.at(-1)).toMatchObject({
      todo: 0,
      inProgress: 1,
      done: 1,
    });
    expect(report.agingWip[0]).toMatchObject({
      issueKey: second.key,
      summary: "Aging fixture",
    });
    expect(report.agingWip[0]!.ageSeconds).toBeCloseTo(3 * 86_400, 2);
    await expect(
      getKanbanReports({ ...admin, organizationId: randomUUID() }, access!, {
        from: "2026-01-01",
        to: "2026-01-05",
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("pages and filters a 1,000-issue board within the performance budget", async () => {
    const {
      createIssue,
      createProject,
      getBoardAccess,
      getBoardPage,
      getPool,
      listBoardColumnIssuesPage,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const userId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Scale Test', $2)`,
      [organizationId, `scale-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Scale Admin', 'unused')`,
      [userId, organizationId, `${userId}@example.test`],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')`,
      [organizationId, userId],
    );
    const identity = {
      id: userId,
      organizationId,
      email: `${userId}@example.test`,
      displayName: "Scale Admin",
      organizationRole: "ADMIN" as const,
    };
    const project = await createProject(identity, {
      key: "SCL",
      name: "Scale Test",
    });
    const otherProject = await createProject(identity, {
      key: "SCX",
      name: "Other Scale Test",
    });
    const access = await getBoardAccess(userId, project.boardId);
    const otherAccess = await getBoardAccess(userId, otherProject.boardId);
    expect(access).not.toBeNull();
    expect(otherAccess).not.toBeNull();
    const metadata = await getPool().query<{
      status_id: string;
      issue_type_id: string;
    }>(
      `SELECT s.id AS status_id, it.id AS issue_type_id
         FROM workflows w
         JOIN statuses s ON s.workflow_id = w.id AND s.name = 'Backlog'
         JOIN issue_types it ON it.project_id = w.project_id AND it.name = 'Task'
        WHERE w.project_id = $1 AND w.active`,
      [project.id],
    );
    const statusId = metadata.rows[0]!.status_id;
    const issueTypeId = metadata.rows[0]!.issue_type_id;
    const issueIds = Array.from({ length: 1_000 }, () => randomUUID());
    await getPool().query(
      `INSERT INTO issues
        (id, organization_id, project_id, number, issue_type_id, status_id,
         summary, description, priority, reporter_id, assignee_id, rank)
       SELECT fixture.id, $2, $3, fixture.ordinal, $4, $5,
              'Large board issue ' || fixture.ordinal, '',
              CASE WHEN fixture.ordinal % 2 = 0 THEN 'HIGH' ELSE 'MEDIUM' END,
              $6::uuid,
              CASE WHEN fixture.ordinal % 3 = 0 THEN $6::uuid ELSE NULL END,
              fixture.ordinal * 1024
         FROM unnest($1::uuid[]) WITH ORDINALITY AS fixture(id, ordinal)`,
      [issueIds, organizationId, project.id, issueTypeId, statusId, userId],
    );
    await getPool().query(
      "UPDATE projects SET sequence_counter = 1000 WHERE id = $1",
      [project.id],
    );

    const first = await getBoardPage(project.boardId, access!, { limit: 50 });
    expect(first).not.toBeNull();
    expect(first!.issues).toHaveLength(50);
    const todo = first!.columns.find((column) => column.name === "To Do")!;
    expect(todo.issueCount).toBe(1_000);
    expect(
      first!.columnPages.find((page) => page.columnId === todo.id),
    ).toMatchObject({ total: 1_000, nextCursor: expect.any(String) });

    const visited: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listBoardColumnIssuesPage(
        access!,
        project.boardId,
        todo.id,
        { limit: 50, ...(cursor ? { cursor } : {}) },
      );
      visited.push(...page.items.map((issue) => issue.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(visited).toHaveLength(1_000);
    expect(new Set(visited).size).toBe(1_000);

    const searched = await getBoardPage(project.boardId, access!, {
      limit: 50,
      q: "issue 777",
    });
    expect(searched!.issues.map((issue) => issue.summary)).toEqual([
      "Large board issue 777",
    ]);
    const high = await listBoardColumnIssuesPage(
      access!,
      project.boardId,
      todo.id,
      { limit: 50, priority: "HIGH" },
    );
    expect(high.total).toBe(500);
    expect(high.items.every((issue) => issue.priority === "HIGH")).toBe(true);
    const assigned = await listBoardColumnIssuesPage(
      access!,
      project.boardId,
      todo.id,
      { limit: 50, assignee: userId },
    );
    expect(assigned.total).toBe(333);
    expect(assigned.items.every((issue) => issue.assignee?.id === userId)).toBe(
      true,
    );

    const epic = await createIssue(identity, access!, {
      summary: "Scale epic",
      description: "",
      priority: "MEDIUM",
      issueType: "EPIC",
      labels: ["scale-target"],
    });
    await createIssue(identity, access!, {
      summary: "Scale story",
      description: "",
      priority: "MEDIUM",
      issueType: "STORY",
      parentIssueKey: epic.key,
      labels: ["scale-target"],
    });
    const labelPage = await listBoardColumnIssuesPage(
      access!,
      project.boardId,
      todo.id,
      { limit: 50, label: "SCALE-TARGET" },
    );
    expect(labelPage.total).toBe(2);
    const epicPage = await listBoardColumnIssuesPage(
      access!,
      project.boardId,
      todo.id,
      { limit: 50, epicKey: epic.key },
    );
    expect(epicPage.total).toBe(2);

    const otherBoard = await getBoardPage(otherProject.boardId, otherAccess!, {
      limit: 50,
    });
    await expect(
      listBoardColumnIssuesPage(
        access!,
        project.boardId,
        otherBoard!.columns[0]!.id,
        { limit: 50 },
      ),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "BOARD_COLUMN_NOT_FOUND",
      status: 404,
    });

    const durations: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const startedAt = performance.now();
      await getBoardPage(project.boardId, access!, { limit: 50 });
      durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    expect(durations[4]).toBeLessThan(500);
  });

  it("seeds an empty development board once with launch work", async () => {
    const {
      createProject,
      getBoard,
      getBoardAccess,
      getPool,
      seedDevelopmentBoard,
    } = await import("@vibe/database");
    const organizationId = randomUUID();
    const userId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Development Seed Test', $2)`,
      [organizationId, `development-seed-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'Development Admin', 'unused')`,
      [userId, organizationId, `${userId}@example.test`],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN')`,
      [organizationId, userId],
    );
    const identity = {
      id: userId,
      organizationId,
      email: `${userId}@example.test`,
      displayName: "Development Admin",
      organizationRole: "ADMIN" as const,
    };
    const project = await createProject(identity, {
      key: "DEV",
      name: "Development",
    });

    await expect(seedDevelopmentBoard(identity, project)).resolves.toBe(7);
    await expect(seedDevelopmentBoard(identity, project)).resolves.toBe(0);

    const access = await getBoardAccess(userId, project.boardId);
    expect(access).not.toBeNull();
    const board = await getBoard(project.boardId, access!);
    expect(board).not.toBeNull();
    expect(board!.issues).toHaveLength(7);
    expect(
      board!.columns.map((column) => ({
        name: column.name,
        count: board!.issues.filter((issue) =>
          column.statusIds.includes(issue.statusId),
        ).length,
      })),
    ).toEqual([
      { name: "To Do", count: 3 },
      { name: "In Progress", count: 3 },
      { name: "Done", count: 1 },
    ]);
    expect(
      board!.issues.find(
        (issue) => issue.summary === "Publish the v0.1.0 release candidate",
      ),
    ).toMatchObject({ issueType: "TASK" });
  });
});
