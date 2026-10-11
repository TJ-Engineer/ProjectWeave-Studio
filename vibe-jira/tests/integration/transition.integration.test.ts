import { randomUUID } from "node:crypto";
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
      TRUNCATE idempotency_records, outbox_events, audit_events, issue_events, issues, column_statuses,
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
      issueType: "TASK",
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
      [issueA, ...moreIssues].map((issue) => issue.id),
    );
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
});
