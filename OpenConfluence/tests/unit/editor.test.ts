import {
  CURRENT_SCHEMA_VERSION,
  DOCUMENT_LIMITS,
  SUPPORTED_SCHEMA_VERSIONS,
  type CanonicalEditorAdapter,
  type DocumentNode,
  type TableRowNode,
  documentNodeSchema,
  extractPlainText,
  migrateDocument,
  normalizeDocument,
  openDocument,
  openWithAdapter,
  renderDocumentToHtml,
  renderFutureDocumentToHtml,
} from "@knowledge/editor";
import schemaV1 from "../fixtures/editor/schema-v1.json";
import schemaV2 from "../fixtures/editor/schema-v2.json";
import schemaV3Future from "../fixtures/editor/schema-v3-future.json";
import { describe, expect, it } from "vitest";

function paragraph(text = "body"): DocumentNode["content"][number] {
  return {
    type: "paragraph",
    content: text ? [{ type: "text", text, marks: [] }] : [],
  };
}

function currentDocument(
  content: DocumentNode["content"] = [paragraph()],
): DocumentNode {
  return { type: "doc", schemaVersion: CURRENT_SCHEMA_VERSION, content };
}

describe("canonical editor schema", () => {
  it("ships a deterministic fixture and migration for every supported version", () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toEqual([1, 2]);
    const migratedOnce = migrateDocument(schemaV1);
    const migratedTwice = migrateDocument(schemaV1);
    expect(migratedOnce).toEqual(migratedTwice);
    expect(migratedOnce).toEqual({
      type: "doc",
      schemaVersion: 2,
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Release guide", marks: [] }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Legacy body", marks: [] }],
        },
      ],
    });
    expect(documentNodeSchema.parse(schemaV2)).toEqual(schemaV2);
  });

  it("validates the complete frozen Release 1 vocabulary", () => {
    const parsed = documentNodeSchema.parse(schemaV2);
    expect(parsed.content.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "orderedList",
      "unorderedList",
      "taskList",
      "blockquote",
      "divider",
      "callout",
      "table",
      "codeBlock",
      "image",
      "attachment",
      "expand",
      "tableOfContents",
    ]);
    expect(extractPlainText(parsed)).toContain("Ada");
    expect(extractPlainText(parsed)).toContain("Freeze schema");
  });

  it("normalizes mark ordering and removes exact duplicates", () => {
    const input = currentDocument([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "stable",
            marks: [{ type: "code" }, { type: "bold" }, { type: "bold" }],
          },
        ],
      },
    ]);
    const normalized = normalizeDocument(input);
    const first = normalized.content[0];
    expect(first?.type === "paragraph" ? first.content[0] : null).toEqual({
      type: "text",
      text: "stable",
      marks: [{ type: "bold" }, { type: "code" }],
    });
  });

  it("rejects unsafe current-version nodes, H1 body headings, and URLs", () => {
    expect(() =>
      documentNodeSchema.parse({
        type: "doc",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        content: [{ type: "html", value: "<script>alert(1)</script>" }],
      }),
    ).toThrow();
    expect(() =>
      documentNodeSchema.parse({
        type: "doc",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        content: [{ type: "heading", attrs: { level: 1 }, content: [] }],
      }),
    ).toThrow();
    expect(() =>
      documentNodeSchema.parse({
        type: "doc",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "unsafe",
                marks: [
                  {
                    type: "link",
                    attrs: { href: "javascript:alert(1)", title: null },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      documentNodeSchema.parse(
        currentDocument([
          {
            type: "paragraph",
            content: [{ type: "date", attrs: { value: "2026-02-30" } }],
          },
        ]),
      ),
    ).toThrow(/valid calendar date/);
    expect(() =>
      documentNodeSchema.parse(
        currentDocument([
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "nested links",
                marks: [
                  {
                    type: "link",
                    attrs: { href: "https://example.test/a", title: null },
                  },
                  {
                    type: "link",
                    attrs: { href: "https://example.test/b", title: null },
                  },
                ],
              },
            ],
          },
        ]),
      ),
    ).toThrow(/at most one external link/);
  });

  it("enforces byte, node, depth, list, table, and URL budgets", () => {
    expect(() =>
      documentNodeSchema.parse(
        currentDocument([paragraph("x".repeat(DOCUMENT_LIMITS.bytes))]),
      ),
    ).toThrow(/1 MiB/);

    expect(() =>
      documentNodeSchema.parse(
        currentDocument([
          {
            type: "paragraph",
            content: Array.from({ length: DOCUMENT_LIMITS.nodes }, () => ({
              type: "text",
              text: "x",
              marks: [],
            })),
          },
        ]),
      ),
    ).toThrow(/node limit/);

    let deep: unknown = paragraph();
    for (let index = 0; index < DOCUMENT_LIMITS.depth; index += 1) {
      deep = { type: "blockquote", content: [deep] };
    }
    expect(() =>
      documentNodeSchema.parse({
        type: "doc",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        content: [deep],
      }),
    ).toThrow(/depth/);

    let nestedList: unknown = paragraph();
    for (let index = 0; index <= DOCUMENT_LIMITS.listDepth; index += 1) {
      nestedList = {
        type: "unorderedList",
        content: [{ type: "listItem", content: [nestedList] }],
      };
    }
    expect(() =>
      documentNodeSchema.parse({
        type: "doc",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        content: [nestedList],
      }),
    ).toThrow(/List depth/);

    const row: TableRowNode = {
      type: "tableRow",
      content: [
        {
          type: "tableCell",
          attrs: { header: false },
          content: [paragraph()],
        },
      ],
    };
    expect(() =>
      documentNodeSchema.parse(
        currentDocument([
          {
            type: "table",
            content: Array.from(
              { length: DOCUMENT_LIMITS.tableRows + 1 },
              () => row,
            ),
          },
        ]),
      ),
    ).toThrow();

    const longUrl = `https://example.test/${"x".repeat(DOCUMENT_LIMITS.urlLength)}`;
    expect(() =>
      documentNodeSchema.parse(
        currentDocument([
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "long",
                marks: [
                  { type: "link", attrs: { href: longUrl, title: null } },
                ],
              },
            ],
          },
        ]),
      ),
    ).toThrow();
  });

  it("opens future documents read-only without discarding opaque nodes", () => {
    const opened = openDocument(schemaV3Future);
    expect(opened.mode).toBe("readOnlyFuture");
    if (opened.mode !== "readOnlyFuture")
      throw new Error("Expected future mode");
    expect(opened.sourceVersion).toBe(3);
    expect(opened.raw).toEqual(schemaV3Future);
    expect(opened.document.content[0]).toMatchObject({
      type: "unsupported",
      originalType: "diagram",
      raw: schemaV3Future.content[0],
    });
    expect(renderFutureDocumentToHtml(opened.document)).not.toContain(
      "future-safe",
    );
  });

  it("does not treat unknown current-version content as a future placeholder", () => {
    expect(() =>
      openDocument({
        ...schemaV3Future,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      }),
    ).toThrow();
  });

  it("renders and extracts only validated, escaped projections", () => {
    const document = currentDocument([
      {
        type: "heading",
        attrs: { level: 2 },
        content: [
          {
            type: "text",
            text: '<script>alert("x")</script>',
            marks: [
              {
                type: "link",
                attrs: {
                  href: "https://example.test/?q=<unsafe>",
                  title: '"quoted"',
                },
              },
            ],
          },
        ],
      },
      { type: "tableOfContents", attrs: { minLevel: 2, maxLevel: 6 } },
    ]);
    const html = renderDocumentToHtml(document);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain('aria-label="Table of contents"');
    expect(extractPlainText(document)).toBe('<script>alert("x")</script>');
  });

  it("keeps engine documents behind the canonical adapter boundary", () => {
    interface EngineDocument {
      engineOnly: true;
      text: string;
    }
    const adapter: CanonicalEditorAdapter<EngineDocument> = {
      id: "test-engine",
      canEdit: () => true,
      toEngine: (document) => ({
        engineOnly: true,
        text: extractPlainText(document),
      }),
      toCanonical: (document) => currentDocument([paragraph(document.text)]),
    };
    const opened = openWithAdapter(schemaV1, adapter);
    expect(opened).toMatchObject({
      mode: "editable",
      sourceVersion: 1,
      migrated: true,
      engineDocument: { engineOnly: true, text: "Release guide\nLegacy body" },
    });
    const canonical = adapter.toCanonical({ engineOnly: true, text: "Saved" });
    expect(JSON.stringify(canonical)).not.toContain("engineOnly");
    expect(documentNodeSchema.parse(canonical)).toEqual(canonical);
  });

  it("keeps valid canonical content read-only when an adapter cannot round-trip it", () => {
    const paragraphOnly: CanonicalEditorAdapter<{ text: string }> = {
      id: "paragraph-only",
      canEdit: (document) =>
        document.content.every((block) => block.type === "paragraph"),
      toEngine: (document) => ({ text: extractPlainText(document) }),
      toCanonical: (document) => currentDocument([paragraph(document.text)]),
    };
    const opened = openWithAdapter(schemaV2, paragraphOnly);
    expect(opened).toMatchObject({
      mode: "readOnlyCanonical",
      sourceVersion: CURRENT_SCHEMA_VERSION,
    });
    expect(JSON.stringify(opened)).toContain("orderedList");
  });
});
