import { describe, expect, it, vi } from "vitest";
import {
  boardIssuesQuerySchema,
  createProjectSchema,
  createSavedFilterSchema,
  issueSearchQuerySchema,
  notificationPreferencesSchema,
  updateWorkflowConfigurationSchema,
} from "@vibe/contracts";
import { DomainError } from "@vibe/domain";
import { handleApiError, requireIdempotency } from "../../apps/web/lib/api";

vi.mock("../../apps/web/lib/session", () => ({ currentIdentity: vi.fn() }));

describe("API hardening helpers", () => {
  it("validates bounded board pages and supported server filters", () => {
    expect(
      boardIssuesQuerySchema.parse({
        limit: "50",
        q: "login",
        issueType: "BUG",
        priority: "HIGH",
        assignee: "unassigned",
        label: "customer",
        epicKey: "ENG-42",
      }),
    ).toMatchObject({
      limit: 50,
      q: "login",
      issueType: "BUG",
      priority: "HIGH",
      assignee: "unassigned",
      label: "customer",
      epicKey: "ENG-42",
    });
    expect(boardIssuesQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(
      boardIssuesQuerySchema.safeParse({ assignee: "not-a-user" }).success,
    ).toBe(false);
  });

  it("requires a valid idempotency key and hashes canonical input", () => {
    const withoutKey = new Request("http://localhost/api/v1/projects");
    expect(() => requireIdempotency(withoutKey, {})).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        status: 400,
      }),
    );

    const invalidKey = new Request("http://localhost/api/v1/projects", {
      headers: { "idempotency-key": "short" },
    });
    expect(() => requireIdempotency(invalidKey, {})).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "INVALID_IDEMPOTENCY_KEY",
        status: 400,
      }),
    );

    const request = new Request("http://localhost/api/v1/projects", {
      headers: { "idempotency-key": "request-12345678" },
    });
    expect(
      requireIdempotency(request, { name: "Project", key: "PRJ" }),
    ).toEqual(requireIdempotency(request, { key: "PRJ", name: "Project" }));
  });

  it("defaults projects to the five-status template and accepts the simple template", () => {
    expect(createProjectSchema.parse({ name: "Platform", key: "PLT" })).toEqual(
      { name: "Platform", key: "PLT", template: "FIVE_STATUS" },
    );
    expect(
      createProjectSchema.parse({
        name: "Requests",
        key: "REQ",
        template: "SIMPLE",
      }),
    ).toMatchObject({ template: "SIMPLE" });
    expect(
      createProjectSchema.safeParse({
        name: "Invalid",
        key: "INV",
        template: "UNKNOWN",
      }).success,
    ).toBe(false);
  });

  it("normalizes multi-value search filters and validates date ranges", () => {
    expect(
      issueSearchQuerySchema.parse({
        q: "release blocker",
        projects: ["eng", "OPS"],
        issueTypes: "BUG,TASK",
        priorities: ["CRITICAL", "HIGH"],
        assignees: "unassigned",
        labels: "customer request, urgent",
        createdFrom: "2026-01-01",
        createdTo: "2026-01-31",
        sort: "priority",
      }),
    ).toMatchObject({
      q: "release blocker",
      projects: ["ENG", "OPS"],
      issueTypes: ["BUG", "TASK"],
      priorities: ["CRITICAL", "HIGH"],
      assignees: ["unassigned"],
      labels: ["customer request", "urgent"],
      sort: "priority",
    });
    expect(
      issueSearchQuerySchema.safeParse({
        createdFrom: "2026-02-01",
        createdTo: "2026-01-01",
      }).success,
    ).toBe(false);
    expect(
      issueSearchQuerySchema.safeParse({ statuses: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("validates strict saved-filter definitions", () => {
    expect(
      createSavedFilterSchema.parse({
        name: "Critical bugs",
        visibility: "PROJECT",
        projectKey: "eng",
        query: { issueTypes: "BUG", priorities: "CRITICAL" },
        isQuick: true,
      }),
    ).toMatchObject({
      name: "Critical bugs",
      visibility: "PROJECT",
      projectKey: "ENG",
      query: { issueTypes: ["BUG"], priorities: ["CRITICAL"] },
      isQuick: true,
    });
    expect(
      createSavedFilterSchema.safeParse({
        name: "Unknown fields are rejected",
        visibility: "PRIVATE",
        query: {},
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("validates complete workflow graphs and category coverage", () => {
    const todo = "00000000-0000-4000-8000-000000000001";
    const progress = "00000000-0000-4000-8000-000000000002";
    const done = "00000000-0000-4000-8000-000000000003";
    const column = "00000000-0000-4000-8000-000000000004";
    const valid = {
      version: 1,
      statuses: [
        {
          id: todo,
          name: "To do",
          category: "TODO",
          color: "#112233",
          columnId: column,
        },
        {
          id: progress,
          name: "Doing",
          category: "IN_PROGRESS",
          color: "#445566",
          columnId: column,
        },
        {
          id: done,
          name: "Done",
          category: "DONE",
          color: "#778899",
          columnId: column,
        },
      ],
      transitions: [{ fromStatusId: todo, toStatusId: progress }],
      removedStatusMigrations: [],
    };
    expect(updateWorkflowConfigurationSchema.safeParse(valid).success).toBe(
      true,
    );
    expect(
      updateWorkflowConfigurationSchema.safeParse({
        ...valid,
        statuses: valid.statuses.map((status) => ({
          ...status,
          category: "TODO",
        })),
      }).success,
    ).toBe(false);
    expect(
      updateWorkflowConfigurationSchema.safeParse({
        ...valid,
        transitions: [{ fromStatusId: todo, toStatusId: todo }],
      }).success,
    ).toBe(false);
  });

  it("requires explicit notification preference booleans", () => {
    expect(
      notificationPreferencesSchema.parse({
        mentions: true,
        issueComments: false,
      }),
    ).toEqual({ mentions: true, issueComments: false });
    expect(
      notificationPreferencesSchema.safeParse({ mentions: true }).success,
    ).toBe(false);
    expect(
      notificationPreferencesSchema.safeParse({
        mentions: true,
        issueComments: true,
        email: true,
      }).success,
    ).toBe(false);
  });

  it("returns stable domain and database error envelopes", async () => {
    const forbidden = handleApiError(
      new DomainError("FORBIDDEN", "Not allowed", 403),
      "correlation-123",
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Not allowed",
        correlationId: "correlation-123",
      },
    });

    const duplicate = handleApiError(
      {
        code: "23505",
        constraint: "projects_organization_id_project_key_key",
      },
      "correlation-456",
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: {
        code: "PROJECT_KEY_TAKEN",
        message: "That project key is already in use",
        correlationId: "correlation-456",
      },
    });
  });
});
