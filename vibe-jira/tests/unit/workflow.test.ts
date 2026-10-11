import { describe, expect, it } from "vitest";
import { assertTransition, assertVersion } from "@vibe/domain";

describe("workflow invariants", () => {
  it("accepts only the declared transition and destination", () => {
    expect(() =>
      assertTransition(
        { fromStatusId: "todo", toStatusId: "doing" },
        "todo",
        "doing",
      ),
    ).not.toThrow();
    expect(() =>
      assertTransition(
        { fromStatusId: "todo", toStatusId: "doing" },
        "todo",
        "done",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSITION" }));
  });

  it("rejects stale issue versions", () => {
    expect(() => assertVersion(3, 4)).toThrowError(
      expect.objectContaining({ code: "VERSION_CONFLICT", status: 409 }),
    );
  });
});
