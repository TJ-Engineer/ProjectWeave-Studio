import { describe, expect, it } from "vitest";
import manualSource from "../../docs/user/USER_MANUAL.json";
import { parseManual } from "./manual";

describe("OpenRM user manual", () => {
  const manual = parseManual(manualSource);

  it("provides a substantial, uniquely anchored product guide", () => {
    const anchors = manual.sections.flatMap((section) => [
      section.id,
      ...section.blocks
        .filter((block) => block.type === "subheading")
        .map((block) => block.id),
    ]);

    expect(manual.$schema).toBe("./USER_MANUAL.schema.json");
    expect(manual.schemaVersion).toBe(1);
    expect(manual.title).toBe("OpenRM user manual");
    expect(manual.metadata.documentVersion).toBe("0.4");
    expect(manual.metadata.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manual.sections.length).toBeGreaterThanOrEqual(19);
    expect(anchors.every(Boolean)).toBe(true);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(manual.sections.map((section) => section.id)).toEqual(expect.arrayContaining([
      "requirements-authoring",
      "traceability-and-suspect-links",
      "reviews-and-approvals",
      "verification-and-gate-readiness",
      "troubleshooting",
    ]));
  });

  it("generates one stable table-of-contents target per JSON section", () => {
    const links = manual.sections.map((section) => `#${section.id}`);
    expect(links).toHaveLength(manual.sections.length);
    expect(new Set(links).size).toBe(links.length);
    expect(links.every((link) => /^#[a-z0-9]+(?:-[a-z0-9]+)*$/.test(link))).toBe(true);
  });

  it("rejects structurally invalid manual updates", () => {
    const duplicate = structuredClone(manualSource);
    duplicate.sections[1].id = duplicate.sections[0].id;
    expect(() => parseManual(duplicate)).toThrow(/duplicate anchor/);

    const unsupportedVersion = { ...manualSource, schemaVersion: 2 };
    expect(() => parseManual(unsupportedVersion)).toThrow(/schema version 1/);

    const invalidDate = structuredClone(manualSource);
    invalidDate.metadata.lastVerified = "2026-02-31";
    expect(() => parseManual(invalidDate)).toThrow(/valid ISO calendar date/);
  });
});
