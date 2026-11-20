import { describe, expect, it } from "vitest";
import {
  createIssueSchema,
  updateCompletionActionSchema,
} from "@vibe/contracts";
import {
  assertCompletionActionTaskCanLeaveDone,
  assertStoryCompletionActionsDone,
  DomainError,
} from "@vibe/domain";

describe("Story completion actions", () => {
  it("accepts bounded Story COAs and rejects them on other issue types", () => {
    expect(
      createIssueSchema.parse({
        summary: "Release the feature",
        issueType: "STORY",
        completionActions: ["Add tests", "Publish docs"],
      }).completionActions,
    ).toEqual(["Add tests", "Publish docs"]);
    expect(
      createIssueSchema.safeParse({
        summary: "Ordinary task",
        issueType: "TASK",
        completionActions: ["Must not be accepted"],
      }).success,
    ).toBe(false);
  });

  it("requires completion toggles to be separate from content edits", () => {
    const base = { version: 1, storyVersion: 2 };
    expect(
      updateCompletionActionSchema.safeParse({ ...base, completed: true })
        .success,
    ).toBe(true);
    expect(
      updateCompletionActionSchema.safeParse({
        ...base,
        completed: true,
        summary: "Also rename",
      }).success,
    ).toBe(false);
    expect(updateCompletionActionSchema.safeParse(base).success).toBe(false);
  });

  it("blocks Story completion while a generated task is open", () => {
    expect(() =>
      assertStoryCompletionActionsDone("STORY", "DONE", ["ENG-12"]),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "STORY_COAS_INCOMPLETE",
        status: 409,
      }),
    );
    expect(() =>
      assertStoryCompletionActionsDone("TASK", "DONE", ["ENG-12"]),
    ).not.toThrow();
  });

  it("requires the owning Story to reopen before its COA task", () => {
    expect(() =>
      assertCompletionActionTaskCanLeaveDone("IN_PROGRESS", "DONE", "ENG-4"),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "COA_TASK_REOPEN_REQUIRES_STORY",
        status: 409,
      }),
    );
    expect(() =>
      assertCompletionActionTaskCanLeaveDone(
        "IN_PROGRESS",
        "IN_PROGRESS",
        "ENG-4",
      ),
    ).not.toThrow();
  });
});
