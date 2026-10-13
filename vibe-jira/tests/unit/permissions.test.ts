import { describe, expect, it } from "vitest";
import {
  assertCapability,
  can,
  DomainError,
  parseMentionEmails,
} from "@vibe/domain";

describe("capability resolution", () => {
  it("allows members to transition and soft-delete issues but not restore or administer", () => {
    expect(can("MEMBER", "MEMBER", "issue:transition")).toBe(true);
    expect(can("MEMBER", "MEMBER", "issue:edit")).toBe(true);
    expect(can("MEMBER", "MEMBER", "issue:delete")).toBe(true);
    expect(can("MEMBER", "MEMBER", "issue:restore")).toBe(false);
    expect(can("MEMBER", "MEMBER", "project:admin")).toBe(false);
  });

  it("does not allow viewers to edit issues", () => {
    expect(can("MEMBER", "VIEWER", "issue:view")).toBe(true);
    expect(can("MEMBER", "VIEWER", "issue:create")).toBe(false);
    expect(can("MEMBER", "VIEWER", "issue:edit")).toBe(false);
    expect(can("MEMBER", "VIEWER", "issue:delete")).toBe(false);
    expect(can("MEMBER", "VIEWER", "issue:restore")).toBe(false);
    expect(can("MEMBER", "VIEWER", "issue:transition")).toBe(false);
    expect(can("MEMBER", "VIEWER", "project:admin")).toBe(false);
    expect(can("MEMBER", "VIEWER", "comment:create")).toBe(false);
    expect(can("MEMBER", "VIEWER", "issue:watch")).toBe(true);
  });

  it("lets project users own filters while reserving shared filters for administrators", () => {
    expect(can("MEMBER", "MEMBER", "filter:create")).toBe(true);
    expect(can("MEMBER", "VIEWER", "filter:create")).toBe(true);
    expect(can("MEMBER", "MEMBER", "filter:manage-shared")).toBe(false);
    expect(can("MEMBER", "VIEWER", "filter:manage-shared")).toBe(false);
    expect(can("MEMBER", "ADMIN", "filter:manage-shared")).toBe(true);
    expect(can("ADMIN", null, "filter:manage-shared")).toBe(true);
  });

  it("reserves outbox monitoring for organization administrators", () => {
    expect(can("ADMIN", null, "outbox:monitor")).toBe(true);
    expect(can("MEMBER", "ADMIN", "outbox:monitor")).toBe(false);
    expect(can("MEMBER", "MEMBER", "outbox:monitor")).toBe(false);
  });

  it("reserves the organization audit trail for organization administrators", () => {
    expect(can("ADMIN", null, "audit:read")).toBe(true);
    expect(can("MEMBER", "ADMIN", "audit:read")).toBe(false);
    expect(can("MEMBER", "MEMBER", "audit:read")).toBe(false);
  });

  it("reserves organization administration for organization administrators", () => {
    expect(can("ADMIN", null, "organization:admin")).toBe(true);
    expect(can("MEMBER", "ADMIN", "organization:admin")).toBe(false);
  });

  it("allows project administrators, but not members, to manage data jobs", () => {
    expect(can("MEMBER", "ADMIN", "data:manage")).toBe(true);
    expect(can("MEMBER", "MEMBER", "data:manage")).toBe(false);
    expect(can("ADMIN", null, "data:manage")).toBe(true);
  });

  it("normalizes and deduplicates deterministic email mentions", () => {
    expect(
      parseMentionEmails(
        "Please ask @Member@Vibe.Local and @member@vibe.local, not @missing",
      ),
    ).toEqual(["member@vibe.local"]);
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
    expect(can("ADMIN", null, "project:admin")).toBe(true);
    expect(can("ADMIN", null, "issue:create")).toBe(true);
    expect(can("ADMIN", null, "issue:edit")).toBe(true);
    expect(can("ADMIN", null, "issue:delete")).toBe(true);
    expect(can("ADMIN", null, "issue:restore")).toBe(true);
    expect(can("ADMIN", null, "issue:transition")).toBe(true);
  });
});
