import { describe, expect, it } from "vitest";
import { updateIssueSchema } from "@vibe/contracts";

describe("update issue contract", () => {
  const validInput = {
    summary: "Updated task",
    description: "New details",
    priority: "HIGH" as const,
    assigneeId: null,
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
});
