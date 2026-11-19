import { describe, expect, it } from "vitest";
import {
  assertChildrenCompatible,
  assertIssueParent,
  canParentIssue,
  DomainError,
} from "@vibe/domain";

describe("issue hierarchy", () => {
  it("allows epics to parent standard issues and standard issues to parent subtasks", () => {
    expect(canParentIssue(1, 0)).toBe(true);
    expect(canParentIssue(0, -1)).toBe(true);
    expect(canParentIssue(1, -1)).toBe(false);
    expect(() => assertIssueParent(1, null)).not.toThrow();
    expect(() => assertIssueParent(0, null)).not.toThrow();
    expect(() => assertIssueParent(0, 1)).not.toThrow();
    expect(() => assertIssueParent(-1, 0)).not.toThrow();
  });

  it("requires subtask parents and rejects invalid levels", () => {
    expect(() => assertIssueParent(-1, null)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "PARENT_REQUIRED",
        status: 422,
      }),
    );
    expect(() => assertIssueParent(-1, 1)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "INVALID_PARENT_HIERARCHY",
        status: 422,
      }),
    );
    expect(() => assertIssueParent(1, 0)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "INVALID_PARENT_HIERARCHY",
        status: 422,
      }),
    );
  });

  it("rejects type changes that would invalidate existing children", () => {
    expect(() => assertChildrenCompatible(1, [0, 0])).not.toThrow();
    expect(() => assertChildrenCompatible(0, [-1])).not.toThrow();
    expect(() => assertChildrenCompatible(-1, [0])).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "INCOMPATIBLE_CHILD_HIERARCHY",
        status: 409,
      }),
    );
  });
});
