import { z } from "zod";
import {
  CURRENT_SCHEMA_VERSION,
  type BlockNode,
  type DocumentNode,
  type InlineNode,
  type TextMark,
  assertDocumentSize,
  documentNodeSchema,
} from "./schema";

const legacyTextNodeSchema = z
  .object({ type: z.literal("text"), text: z.string().max(20_000) })
  .strict();
const legacyInlineContentSchema = z.array(legacyTextNodeSchema).max(500);
const legacyDocumentSchema = z
  .object({
    type: z.literal("doc"),
    schemaVersion: z.literal(1),
    content: z
      .array(
        z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("heading"),
              attrs: z
                .object({
                  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
                })
                .strict(),
              content: legacyInlineContentSchema,
            })
            .strict(),
          z
            .object({
              type: z.literal("paragraph"),
              content: legacyInlineContentSchema,
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(500),
  })
  .strict();

const versionSchema = z
  .object({ schemaVersion: z.number().int().positive() })
  .passthrough();

export class UnsupportedDocumentVersionError extends Error {
  constructor(public readonly version: number) {
    super(`Document schema version ${version} is not supported for editing`);
    this.name = "UnsupportedDocumentVersionError";
  }
}

const markOrder: Record<TextMark["type"], number> = {
  bold: 0,
  italic: 1,
  underline: 2,
  strike: 3,
  code: 4,
  link: 5,
};

function normalizeMarks(marks: TextMark[]): TextMark[] {
  const unique = new Map<string, TextMark>();
  for (const mark of marks) unique.set(JSON.stringify(mark), mark);
  return [...unique.values()].sort(
    (left, right) =>
      markOrder[left.type] - markOrder[right.type] ||
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function normalizeInline(node: InlineNode): InlineNode {
  return node.type === "text"
    ? { ...node, marks: normalizeMarks(node.marks) }
    : node;
}

function normalizeBlock(block: BlockNode): BlockNode {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return { ...block, content: block.content.map(normalizeInline) };
    case "orderedList":
    case "unorderedList":
      return {
        ...block,
        content: block.content.map((item) => ({
          ...item,
          content: item.content.map(normalizeBlock),
        })),
      };
    case "taskList":
      return {
        ...block,
        content: block.content.map((item) => ({
          ...item,
          content: item.content.map(normalizeBlock),
        })),
      };
    case "blockquote":
    case "callout":
    case "expand":
      return { ...block, content: block.content.map(normalizeBlock) };
    case "table":
      return {
        ...block,
        content: block.content.map((row) => ({
          ...row,
          content: row.content.map((cell) => ({
            ...cell,
            content: cell.content.map(normalizeBlock),
          })),
        })),
      };
    case "divider":
    case "codeBlock":
    case "image":
    case "attachment":
    case "tableOfContents":
      return block;
  }
}

export function normalizeDocument(input: DocumentNode): DocumentNode {
  const parsed = documentNodeSchema.parse(input);
  return documentNodeSchema.parse({
    ...parsed,
    content: parsed.content.map(normalizeBlock),
  });
}

function migrateVersionOne(input: unknown): DocumentNode {
  const legacy = legacyDocumentSchema.parse(input);
  return documentNodeSchema.parse({
    type: "doc",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    content: legacy.content.map((block) =>
      block.type === "heading"
        ? {
            type: "heading" as const,
            attrs: { level: (block.attrs.level + 1) as 2 | 3 | 4 },
            content: block.content.map((node) => ({ ...node, marks: [] })),
          }
        : {
            type: "paragraph" as const,
            content: block.content.map((node) => ({ ...node, marks: [] })),
          },
    ),
  });
}

export function migrateDocument(input: unknown): DocumentNode {
  assertDocumentSize(input);
  const version = versionSchema.parse(input).schemaVersion;
  if (version === CURRENT_SCHEMA_VERSION) {
    return normalizeDocument(documentNodeSchema.parse(input));
  }
  if (version === 1) return normalizeDocument(migrateVersionOne(input));
  throw new UnsupportedDocumentVersionError(version);
}
