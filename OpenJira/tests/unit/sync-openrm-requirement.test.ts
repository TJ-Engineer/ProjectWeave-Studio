import { describe, expect, it } from "vitest";
import {
  jiraPriority,
  managedRequirementBlock,
  mergeManagedDescription,
  parseSyncOptions,
  planRequirementSync,
  requirementSummary,
  summarizeSyncPlans,
  type JiraIssue,
  type OpenRmRequirement,
} from "../../scripts/sync-openrm-requirement";

function requirement(
  overrides: Partial<OpenRmRequirement> = {},
): OpenRmRequirement {
  return {
    id: "1706b72b-7354-4f49-92a4-453283154d4f",
    projectId: "00000000-0000-4000-8000-000000000102",
    key: "ORM-011",
    title: "Code Base",
    statement: "OpenRM shall use React and Rust.",
    attributes: { priority: "high" },
    revision: 1,
    updatedAt: "2026-11-12T18:56:55.608460Z",
    ...overrides,
  };
}

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  const createPlan = planRequirementSync(requirement(), null);
  const input = createPlan.input!;
  return {
    key: "ORM-1",
    summary: input.summary,
    description: input.description,
    priority: input.priority,
    issueType: input.issueType,
    assigneeId: input.assigneeId,
    labels: input.labels,
    parentIssueKey: input.parentIssueKey,
    estimatePoints: input.estimatePoints,
    dueDate: input.dueDate,
    version: 1,
    ...overrides,
  };
}

describe("OpenRM requirement synchronization", () => {
  it("plans an idempotently identifiable Jira task", () => {
    const plan = planRequirementSync(requirement(), null);
    expect(plan).toMatchObject({
      action: "create",
      issueKey: null,
      requirement: { key: "ORM-011", revision: 1 },
      input: {
        summary: "[ORM-011] Code Base",
        priority: "HIGH",
        issueType: "TASK",
        labels: ["openrm", "ORM-011", "openrm-rev-1"],
      },
    });
    expect(plan.input?.description).toContain("OpenRM requirement ID:");
  });

  it("preserves human-authored description text and unmanaged fields on update", () => {
    const current = issue({
      description: `${managedRequirementBlock(requirement())}\n\nImplementation notes stay here.`,
      labels: ["team-alpha", "openrm", "ORM-011", "openrm-rev-1"],
      assigneeId: "9e96d45e-0de3-45ce-9b61-206150bee962",
      estimatePoints: 5,
    });
    const plan = planRequirementSync(
      requirement({
        revision: 2,
        statement: "OpenRM shall use React, Rust, and PostgreSQL.",
      }),
      current,
    );
    expect(plan.action).toBe("update");
    expect(plan.changedFields).toEqual(["description", "labels"]);
    expect(plan.input).toMatchObject({
      assigneeId: current.assigneeId,
      estimatePoints: 5,
      version: 1,
    });
    expect(plan.input?.description).toContain(
      "Implementation notes stay here.",
    );
    expect(plan.input?.labels).toEqual([
      "team-alpha",
      "openrm",
      "ORM-011",
      "openrm-rev-2",
    ]);
  });

  it("produces a no-op when the current revision is already synchronized", () => {
    expect(planRequirementSync(requirement(), issue())).toMatchObject({
      action: "noop",
      issueKey: "ORM-1",
      changedFields: [],
      input: null,
    });
  });

  it("fails closed around malformed managed markers", () => {
    expect(() =>
      mergeManagedDescription(
        "<!-- openrm-sync:start -->\nmissing end marker",
        managedRequirementBlock(requirement()),
      ),
    ).toThrow("malformed OpenRM managed block");
  });

  it("maps unknown priorities safely and bounds long summaries", () => {
    const input = requirement({
      title: "A".repeat(200),
      attributes: { priority: "urgent" },
    });
    expect(jiraPriority(input)).toBe("MEDIUM");
    expect(requirementSummary(input)).toHaveLength(200);
  });

  it("summarizes a bounded project preflight", () => {
    const create = planRequirementSync(requirement(), null);
    const noop = planRequirementSync(requirement(), issue());
    const update = planRequirementSync(requirement({ revision: 2 }), issue());
    expect(summarizeSyncPlans([create, noop, update])).toEqual({
      total: 3,
      create: 1,
      update: 1,
      noop: 1,
    });
  });

  it("requires exactly one single or project-wide scope", () => {
    const common = [
      "--openrm-project",
      "00000000-0000-4000-8000-000000000102",
      "--jira-project",
      "ORM",
    ];
    expect(parseSyncOptions([...common, "--all", "--max", "25"])).toMatchObject(
      {
        scope: "all",
        maxRequirements: 25,
        apply: false,
      },
    );
    expect(() => parseSyncOptions(common)).toThrow("Usage:");
    expect(() =>
      parseSyncOptions([...common, "--all", "--requirement", "ORM-001"]),
    ).toThrow("Usage:");
  });
});
