import { describe, expect, it } from "vitest";
import { updateBoardColumnWipLimitSchema } from "@vibe/contracts";

describe("board WIP limit contract", () => {
  it("accepts a positive limit or an explicit disabled value", () => {
    expect(
      updateBoardColumnWipLimitSchema.parse({ wipLimit: 12, version: 3 }),
    ).toEqual({ wipLimit: 12, version: 3 });
    expect(
      updateBoardColumnWipLimitSchema.parse({ wipLimit: null, version: 4 }),
    ).toEqual({ wipLimit: null, version: 4 });
  });

  it.each([0, -1, 1.5, 10_001])("rejects invalid limit %s", (wipLimit) => {
    expect(
      updateBoardColumnWipLimitSchema.safeParse({ wipLimit, version: 1 })
        .success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      updateBoardColumnWipLimitSchema.safeParse({
        wipLimit: 3,
        version: 1,
        enforce: true,
      }).success,
    ).toBe(false);
  });
});
