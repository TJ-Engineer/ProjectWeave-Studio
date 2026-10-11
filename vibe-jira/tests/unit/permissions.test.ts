import { describe, expect, it } from "vitest";
import { assertCapability, can, DomainError } from "@vibe/domain";

describe("capability resolution", () => {
  it("allows members to transition issues but not administer projects", () => {
    expect(can("MEMBER", "MEMBER", "issue:transition")).toBe(true);
    expect(can("MEMBER", "MEMBER", "issue:edit")).toBe(true);
    expect(can("MEMBER", "MEMBER", "project:admin")).toBe(false);
  });

  it("does not allow viewers to edit issues", () => {
    expect(can("MEMBER", "VIEWER", "issue:view")).toBe(true);
    expect(can("MEMBER", "VIEWER", "issue:edit")).toBe(false);
  });

  it("does not grant access without project membership", () => {
    expect(can("MEMBER", null, "issue:view")).toBe(false);
    expect(() => assertCapability("MEMBER", null, "issue:view")).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "FORBIDDEN",
        status: 403,
      }),
    );
  });

  it("allows an organization administrator to create projects", () => {
    expect(can("ADMIN", null, "project:create")).toBe(true);
  });
});
