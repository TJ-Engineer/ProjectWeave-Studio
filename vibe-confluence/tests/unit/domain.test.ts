import {
  CURRENT_SCHEMA_VERSION,
  documentNodeSchema,
  emptyDocument,
  movePageSchema,
  pageLifecycleActionSchema,
  pageTreeQuerySchema,
} from "@knowledge/contracts";
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
    expect(can("ADMIN", null, "page:move")).toBe(true);
    expect(can("ADMIN", null, "page:archive")).toBe(true);
    expect(can("MEMBER", "ADMIN", "page:move")).toBe(true);
    expect(can("MEMBER", "ADMIN", "page:archive")).toBe(true);
    expect(can("MEMBER", "EDITOR", "page:move")).toBe(false);
    expect(can("MEMBER", "EDITOR", "page:archive")).toBe(false);
    expect(can("MEMBER", "EDITOR", "page:trash")).toBe(true);
    expect(can("MEMBER", "EDITOR", "page:publish")).toBe(true);
    expect(can("MEMBER", "VIEWER", "page:publish")).toBe(false);
    expect(can("MEMBER", "ADMIN", "audit:read")).toBe(false);
  });

  it("validates versioned page lifecycle actions", () => {
    expect(
      pageLifecycleActionSchema.parse({
        action: "RESTORE",
        expectedVersion: 3,
        expectedParentVersion: 7,
        destinationParentId: null,
        beforePageId: null,
        afterPageId: null,
      }),
    ).toMatchObject({ action: "RESTORE", destinationParentId: null });
    expect(() =>
      pageLifecycleActionSchema.parse({
        action: "TRASH",
        expectedVersion: 3,
        expectedParentVersion: 7,
        destinationParentId: null,
      }),
    ).toThrow();
  });

  it("bounds tree reads and validates versioned page movement", () => {
    expect(
      pageTreeQuerySchema.parse({ parentId: null, cursor: null, limit: "100" }),
    ).toEqual({ parentId: null, cursor: null, limit: 100 });
    expect(() =>
      pageTreeQuerySchema.parse({ parentId: null, cursor: null, limit: "101" }),
    ).toThrow();
    expect(() =>
      movePageSchema.parse({
        destinationParentId: null,
        beforePageId: "00000000-0000-4000-8000-000000000001",
        afterPageId: "00000000-0000-4000-8000-000000000001",
        expectedSourceVersion: 1,
        expectedDestinationVersion: 1,
      }),
    ).toThrow();
  });

  it("validates only the frozen current document schema", () => {
    expect(documentNodeSchema.parse(emptyDocument)).toEqual(emptyDocument);
    expect(() =>
      documentNodeSchema.parse({
        type: "doc",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        content: [{ type: "html", value: "<script>alert(1)</script>" }],
      }),
    ).toThrow();
  });

  it("extracts text and produces a stable line diff", () => {
    const after = documentNodeSchema.parse({
      type: "doc",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Launch", marks: [] }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Ready", marks: [] }],
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
