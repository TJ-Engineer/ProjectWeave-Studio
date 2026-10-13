import { describe, expect, it } from "vitest";
import { transitionIssueSchema } from "@vibe/contracts";

const id = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("board ordering contract", () => {
  it("accepts neighbor-based placement without a client-authored rank", () => {
    expect(
      transitionIssueSchema.parse({
        transitionId: null,
        destinationColumnId: id("1"),
        destinationStatusId: id("2"),
        beforeIssueId: id("3"),
        afterIssueId: id("4"),
        version: 7,
      }),
    ).toEqual({
      transitionId: null,
      destinationColumnId: id("1"),
      destinationStatusId: id("2"),
      beforeIssueId: id("3"),
      afterIssueId: id("4"),
      version: 7,
    });
  });

  it("rejects client-authored ranks", () => {
    const request = {
      transitionId: null,
      destinationColumnId: id("1"),
      destinationStatusId: id("2"),
      beforeIssueId: id("3"),
      afterIssueId: id("4"),
      destinationRank: 999999,
      version: 1,
    };
    expect(transitionIssueSchema.safeParse(request).success).toBe(false);
  });

  it("rejects duplicate neighbors", () => {
    expect(
      transitionIssueSchema.safeParse({
        transitionId: null,
        destinationColumnId: id("1"),
        destinationStatusId: id("2"),
        beforeIssueId: id("3"),
        afterIssueId: id("3"),
        version: 1,
      }).success,
    ).toBe(false);
  });
});
