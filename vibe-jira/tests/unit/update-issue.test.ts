import { describe, expect, it } from "vitest";
import { issueLifecycleSchema, updateIssueSchema } from "@vibe/contracts";

describe("update issue contract", () => {
  const validInput = {
    summary: "Updated task",
    description: "New details",
    priority: "HIGH" as const,
    issueType: "STORY" as const,
    assigneeId: null,
    labels: ["frontend", "customer request"],
    parentIssueKey: "ENG-142",
    estimatePoints: 8,
    dueDate: "2026-12-15",
    version: 2,
  };

  it("accepts the complete editable field set", () => {
    expect(updateIssueSchema.parse(validInput)).toEqual(validInput);
  });

  it("rejects empty summaries and unknown fields", () => {
    expect(() =>
      updateIssueSchema.parse({ ...validInput, summary: "   " }),
    ).toThrow();
    expect(() =>
      updateIssueSchema.parse({ ...validInput, statusId: crypto.randomUUID() }),
    ).toThrow();
  });

  it("rejects duplicate normalized labels and invalid parent keys", () => {
    expect(() =>
      updateIssueSchema.parse({
        ...validInput,
        labels: ["Customer Request", " customer   request "],
      }),
    ).toThrow();
    expect(() =>
      updateIssueSchema.parse({
        ...validInput,
        parentIssueKey: "not-an-issue",
      }),
    ).toThrow();
  });

  it("rejects invalid estimates and calendar dates", () => {
    expect(() =>
      updateIssueSchema.parse({ ...validInput, estimatePoints: -1 }),
    ).toThrow();
    expect(() =>
      updateIssueSchema.parse({ ...validInput, dueDate: "2026-02-31" }),
    ).toThrow();
  });
});

describe("issue lifecycle contract", () => {
  it("requires one positive version and rejects extra fields", () => {
    expect(issueLifecycleSchema.parse({ version: 3 })).toEqual({ version: 3 });
    expect(() => issueLifecycleSchema.parse({ version: 0 })).toThrow();
    expect(() =>
      issueLifecycleSchema.parse({ version: 3, permanent: true }),
    ).toThrow();
  });
});
