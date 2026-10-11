import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@vibe/domain";

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
      TRUNCATE outbox_events, audit_events, issue_events, issues, column_statuses,
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
      destinationStatusId: transition.toStatusId,
      destinationRank: 1024,
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

  it("updates editable fields atomically and rejects stale or invalid writes", async () => {
    const { createIssue, createProject, getBoardAccess, getPool, updateIssue } =
      await import("@vibe/database");
    const organizationId = randomUUID();
    const userId = randomUUID();
    const assigneeId = randomUUID();
    const nonMemberId = randomUUID();
    await getPool().query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Edit Test', $2)`,
      [organizationId, `edit-${organizationId}`],
    );
    await getPool().query(
      `INSERT INTO users (id, organization_id, email, display_name, password_hash)
       VALUES
         ($1, $2, $3, 'Editor', 'unused'),
         ($4, $2, $5, 'Assignee', 'unused'),
         ($6, $2, $7, 'Non Member', 'unused')`,
      [
        userId,
        organizationId,
        `${userId}@example.test`,
        assigneeId,
        `${assigneeId}@example.test`,
        nonMemberId,
        `${nonMemberId}@example.test`,
      ],
    );
    await getPool().query(
      `INSERT INTO memberships (organization_id, user_id, organization_role)
       VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER'), ($1, $4, 'MEMBER')`,
      [organizationId, userId, assigneeId, nonMemberId],
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
       VALUES ($1, $2, $3, 'MEMBER')`,
      [organizationId, project.id, assigneeId],
    );
    const access = await getBoardAccess(userId, project.boardId);
    expect(access).not.toBeNull();
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
      assigneeId,
      version: issue.version,
    };
    const updated = await updateIssue(identity, access!, issue.key, update);
    expect(updated).toMatchObject({
      summary: update.summary,
      description: update.description,
      priority: update.priority,
      assignee: { id: assigneeId, displayName: "Assignee" },
      version: issue.version + 1,
    });
    expect(updated.events.at(-1)).toMatchObject({
      eventType: "UPDATED",
      payload: {
        fields: ["summary", "description", "priority", "assignee"],
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
        assigneeId: nonMemberId,
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
          fields: ["summary", "description", "priority", "assignee"],
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
});
