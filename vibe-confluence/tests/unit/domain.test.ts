import { documentNodeSchema, emptyDocument } from "@knowledge/contracts";
import {
  can,
  diffDocuments,
  documentToPlainText,
  hashPassword,
  slugify,
  verifyPassword,
} from "@knowledge/domain";
import { describe, expect, it } from "vitest";

describe("knowledge domain", () => {
  it("keeps organization administration distinct from space roles", () => {
    expect(can("ADMIN", null, "space:create")).toBe(true);
    expect(can("MEMBER", "EDITOR", "page:publish")).toBe(true);
    expect(can("MEMBER", "VIEWER", "page:publish")).toBe(false);
    expect(can("MEMBER", "ADMIN", "audit:read")).toBe(false);
  });

  it("validates only the versioned minimal document schema", () => {
    expect(documentNodeSchema.parse(emptyDocument)).toEqual(emptyDocument);
    expect(() =>
      documentNodeSchema.parse({
        type: "doc",
        schemaVersion: 1,
        content: [{ type: "html", value: "<script>alert(1)</script>" }],
      }),
    ).toThrow();
  });

  it("extracts text and produces a stable line diff", () => {
    const after = documentNodeSchema.parse({
      type: "doc",
      schemaVersion: 1,
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Launch" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Ready" }],
        },
      ],
    });
    expect(documentToPlainText(after)).toBe("Launch\nReady");
    expect(diffDocuments(emptyDocument, after)).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "Launch" },
      { kind: "added", text: "Ready" },
    ]);
  });

  it("creates durable slugs and password hashes", async () => {
    expect(slugify("  Résumé & Launch!  ")).toBe("resume-launch");
    const hash = await hashPassword("correct horse battery staple");
    await expect(
      verifyPassword("correct horse battery staple", hash),
    ).resolves.toBe(true);
    await expect(verifyPassword("incorrect", hash)).resolves.toBe(false);
  });
});
