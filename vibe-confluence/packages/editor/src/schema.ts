import { z } from "zod";

export const CURRENT_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_SCHEMA_VERSIONS = [1, CURRENT_SCHEMA_VERSION] as const;

export const DOCUMENT_LIMITS = Object.freeze({
  bytes: 1_048_576,
  nodes: 10_000,
  depth: 12,
  listDepth: 6,
  tableRows: 200,
  tableColumns: 50,
  headingMin: 2,
  headingMax: 6,
  urlLength: 2_048,
});

export type TextMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "strike" }
  | { type: "code" }
  | {
      type: "link";
      attrs: { href: string; title: string | null };
    };

export interface TextNode {
  type: "text";
  text: string;
  marks: TextMark[];
}

export interface PageLinkNode {
  type: "pageLink";
  attrs: { pageId: string; label: string };
}

export interface UserMentionNode {
  type: "userMention";
  attrs: { userId: string; label: string };
}

export interface LabelReferenceNode {
  type: "labelReference";
  attrs: { label: string };
}

export interface DateNode {
  type: "date";
  attrs: { value: string };
}

export interface TaskReferenceNode {
  type: "taskReference";
  attrs: { taskId: string; label: string };
}

export interface StatusNode {
  type: "status";
  attrs: {
    text: string;
    tone: "neutral" | "info" | "success" | "warning" | "danger";
  };
}

export type InlineNode =
  | TextNode
  | PageLinkNode
  | UserMentionNode
  | LabelReferenceNode
  | DateNode
  | TaskReferenceNode
  | StatusNode;

export interface ParagraphNode {
  type: "paragraph";
  content: InlineNode[];
}

export interface HeadingNode {
  type: "heading";
  attrs: { level: 2 | 3 | 4 | 5 | 6 };
  content: InlineNode[];
}

export interface ListItemNode {
  type: "listItem";
  content: BlockNode[];
}

export interface TaskItemNode {
  type: "taskItem";
  attrs: { checked: boolean };
  content: BlockNode[];
}

export interface OrderedListNode {
  type: "orderedList";
  attrs: { start: number };
  content: ListItemNode[];
}

export interface UnorderedListNode {
  type: "unorderedList";
  content: ListItemNode[];
}

export interface TaskListNode {
  type: "taskList";
  content: TaskItemNode[];
}

export interface BlockquoteNode {
  type: "blockquote";
  content: BlockNode[];
}

export interface DividerNode {
  type: "divider";
}

export interface CalloutNode {
  type: "callout";
  attrs: {
    tone: "info" | "note" | "success" | "warning" | "danger";
    title: string | null;
  };
  content: BlockNode[];
}

export interface TableCellNode {
  type: "tableCell";
  attrs: { header: boolean };
  content: BlockNode[];
}

export interface TableRowNode {
  type: "tableRow";
  content: TableCellNode[];
}

export interface TableNode {
  type: "table";
  content: TableRowNode[];
}

export interface CodeBlockNode {
  type: "codeBlock";
  attrs: { language: string | null };
  code: string;
}

export interface ImageNode {
  type: "image";
  attrs: { assetId: string; altText: string; caption: string | null };
}

export interface AttachmentNode {
  type: "attachment";
  attrs: { assetId: string; fileName: string; caption: string | null };
}

export interface ExpandNode {
  type: "expand";
  attrs: { summary: string };
  content: BlockNode[];
}

export interface TableOfContentsNode {
  type: "tableOfContents";
  attrs: { minLevel: 2 | 3 | 4 | 5 | 6; maxLevel: 2 | 3 | 4 | 5 | 6 };
}

export type BlockNode =
  | ParagraphNode
  | HeadingNode
  | OrderedListNode
  | UnorderedListNode
  | TaskListNode
  | BlockquoteNode
  | DividerNode
  | CalloutNode
  | TableNode
  | CodeBlockNode
  | ImageNode
  | AttachmentNode
  | ExpandNode
  | TableOfContentsNode;

export interface DocumentNode {
  type: "doc";
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  content: BlockNode[];
}

export type DocumentBlock = BlockNode;

const shortTextSchema = z.string().max(2_000);
const labelSchema = z.string().min(1).max(200);
const headingLevelSchema = z.union([
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO calendar date")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value)
    );
  }, "Use a valid calendar date");

const safeUrlSchema = z
  .string()
  .max(DOCUMENT_LIMITS.urlLength)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return (
        protocol === "http:" || protocol === "https:" || protocol === "mailto:"
      );
    } catch {
      return false;
    }
  }, "Use an absolute HTTP, HTTPS, or mailto URL");

const markSchema: z.ZodType<TextMark> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }).strict(),
  z.object({ type: z.literal("italic") }).strict(),
  z.object({ type: z.literal("underline") }).strict(),
  z.object({ type: z.literal("strike") }).strict(),
  z.object({ type: z.literal("code") }).strict(),
  z
    .object({
      type: z.literal("link"),
      attrs: z
        .object({ href: safeUrlSchema, title: shortTextSchema.nullable() })
        .strict(),
    })
    .strict(),
]);

const inlineNodeSchema: z.ZodType<InlineNode> = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().max(DOCUMENT_LIMITS.bytes),
      marks: z.array(markSchema).max(6),
    })
    .strict(),
  z
    .object({
      type: z.literal("pageLink"),
      attrs: z.object({ pageId: z.uuid(), label: labelSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("userMention"),
      attrs: z.object({ userId: z.uuid(), label: labelSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("labelReference"),
      attrs: z.object({ label: labelSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("date"),
      attrs: z.object({ value: calendarDateSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("taskReference"),
      attrs: z.object({ taskId: labelSchema, label: labelSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("status"),
      attrs: z
        .object({
          text: labelSchema,
          tone: z.enum(["neutral", "info", "success", "warning", "danger"]),
        })
        .strict(),
    })
    .strict(),
]);

const inlineContentSchema = z
  .array(inlineNodeSchema)
  .max(DOCUMENT_LIMITS.nodes);

export const blockNodeSchema: z.ZodType<BlockNode> = z.lazy(() => {
  const blockContentSchema = z
    .array(blockNodeSchema)
    .max(DOCUMENT_LIMITS.nodes);
  const listItemSchema: z.ZodType<ListItemNode> = z
    .object({
      type: z.literal("listItem"),
      content: blockContentSchema.min(1),
    })
    .strict();
  const taskItemSchema: z.ZodType<TaskItemNode> = z
    .object({
      type: z.literal("taskItem"),
      attrs: z.object({ checked: z.boolean() }).strict(),
      content: blockContentSchema.min(1),
    })
    .strict();
  const tableCellSchema: z.ZodType<TableCellNode> = z
    .object({
      type: z.literal("tableCell"),
      attrs: z.object({ header: z.boolean() }).strict(),
      content: blockContentSchema.min(1),
    })
    .strict();
  const tableRowSchema: z.ZodType<TableRowNode> = z
    .object({
      type: z.literal("tableRow"),
      content: z
        .array(tableCellSchema)
        .min(1)
        .max(DOCUMENT_LIMITS.tableColumns),
    })
    .strict();

  return z.discriminatedUnion("type", [
    z
      .object({ type: z.literal("paragraph"), content: inlineContentSchema })
      .strict(),
    z
      .object({
        type: z.literal("heading"),
        attrs: z.object({ level: headingLevelSchema }).strict(),
        content: inlineContentSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("orderedList"),
        attrs: z
          .object({ start: z.number().int().min(1).max(1_000_000) })
          .strict(),
        content: z.array(listItemSchema).min(1).max(DOCUMENT_LIMITS.nodes),
      })
      .strict(),
    z
      .object({
        type: z.literal("unorderedList"),
        content: z.array(listItemSchema).min(1).max(DOCUMENT_LIMITS.nodes),
      })
      .strict(),
    z
      .object({
        type: z.literal("taskList"),
        content: z.array(taskItemSchema).min(1).max(DOCUMENT_LIMITS.nodes),
      })
      .strict(),
    z
      .object({
        type: z.literal("blockquote"),
        content: blockContentSchema.min(1),
      })
      .strict(),
    z.object({ type: z.literal("divider") }).strict(),
    z
      .object({
        type: z.literal("callout"),
        attrs: z
          .object({
            tone: z.enum(["info", "note", "success", "warning", "danger"]),
            title: shortTextSchema.nullable(),
          })
          .strict(),
        content: blockContentSchema.min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("table"),
        content: z.array(tableRowSchema).min(1).max(DOCUMENT_LIMITS.tableRows),
      })
      .strict(),
    z
      .object({
        type: z.literal("codeBlock"),
        attrs: z.object({ language: z.string().max(100).nullable() }).strict(),
        code: z.string().max(DOCUMENT_LIMITS.bytes),
      })
      .strict(),
    z
      .object({
        type: z.literal("image"),
        attrs: z
          .object({
            assetId: z.uuid(),
            altText: shortTextSchema,
            caption: shortTextSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal("attachment"),
        attrs: z
          .object({
            assetId: z.uuid(),
            fileName: labelSchema,
            caption: shortTextSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal("expand"),
        attrs: z.object({ summary: labelSchema }).strict(),
        content: blockContentSchema.min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("tableOfContents"),
        attrs: z
          .object({
            minLevel: headingLevelSchema,
            maxLevel: headingLevelSchema,
          })
          .strict()
          .refine((attrs) => attrs.minLevel <= attrs.maxLevel, {
            message: "Table of contents levels must be ordered",
          }),
      })
      .strict(),
  ]);
});

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validateDocumentBudgets(
  document: DocumentNode,
  context: z.RefinementCtx,
): void {
  if (serializedBytes(document) > DOCUMENT_LIMITS.bytes) {
    context.addIssue({
      code: "custom",
      message: "Document exceeds the 1 MiB canonical JSON limit",
    });
  }

  let nodes = 1;
  const countInline = (content: InlineNode[]) => {
    nodes += content.length;
    for (const node of content) {
      if (
        node.type === "text" &&
        node.marks.filter((mark) => mark.type === "link").length > 1
      ) {
        context.addIssue({
          code: "custom",
          message: "Text may have at most one external link mark",
        });
      }
    }
  };
  const visitBlocks = (
    content: BlockNode[],
    depth: number,
    listDepth: number,
  ) => {
    if (depth > DOCUMENT_LIMITS.depth) {
      context.addIssue({
        code: "custom",
        message: `Document depth exceeds ${DOCUMENT_LIMITS.depth}`,
      });
      return;
    }
    for (const block of content) {
      nodes += 1;
      switch (block.type) {
        case "paragraph":
        case "heading":
          countInline(block.content);
          break;
        case "orderedList":
        case "unorderedList": {
          const nextListDepth = listDepth + 1;
          if (nextListDepth > DOCUMENT_LIMITS.listDepth) {
            context.addIssue({
              code: "custom",
              message: `List depth exceeds ${DOCUMENT_LIMITS.listDepth}`,
            });
          }
          for (const item of block.content) {
            nodes += 1;
            visitBlocks(item.content, depth + 1, nextListDepth);
          }
          break;
        }
        case "taskList": {
          const nextListDepth = listDepth + 1;
          if (nextListDepth > DOCUMENT_LIMITS.listDepth) {
            context.addIssue({
              code: "custom",
              message: `List depth exceeds ${DOCUMENT_LIMITS.listDepth}`,
            });
          }
          for (const item of block.content) {
            nodes += 1;
            visitBlocks(item.content, depth + 1, nextListDepth);
          }
          break;
        }
        case "blockquote":
        case "callout":
        case "expand":
          visitBlocks(block.content, depth + 1, listDepth);
          break;
        case "table":
          if (!block.content[0]?.content.every((cell) => cell.attrs.header)) {
            context.addIssue({
              code: "custom",
              message: "The first table row must contain header cells",
            });
          }
          if (
            block.content.some(
              (row) => row.content.length !== block.content[0]?.content.length,
            )
          ) {
            context.addIssue({
              code: "custom",
              message: "Every table row must contain the same number of cells",
            });
          }
          for (const row of block.content) {
            nodes += 1;
            for (const cell of row.content) {
              nodes += 1;
              visitBlocks(cell.content, depth + 1, listDepth);
            }
          }
          break;
        case "divider":
        case "codeBlock":
        case "image":
        case "attachment":
        case "tableOfContents":
          break;
      }
    }
  };

  visitBlocks(document.content, 1, 0);
  if (nodes > DOCUMENT_LIMITS.nodes) {
    context.addIssue({
      code: "custom",
      message: `Document exceeds the ${DOCUMENT_LIMITS.nodes.toLocaleString("en-US")} node limit`,
    });
  }
}

export const documentNodeSchema: z.ZodType<DocumentNode> = z
  .object({
    type: z.literal("doc"),
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    content: z.array(blockNodeSchema).min(1).max(DOCUMENT_LIMITS.nodes),
  })
  .strict()
  .superRefine(validateDocumentBudgets);

export const emptyDocument: DocumentNode = {
  type: "doc",
  schemaVersion: CURRENT_SCHEMA_VERSION,
  content: [{ type: "paragraph", content: [] }],
};

export function assertDocumentSize(value: unknown): void {
  let bytes: number;
  try {
    bytes = serializedBytes(value);
  } catch {
    throw new Error("Document must be serializable JSON");
  }
  if (bytes > DOCUMENT_LIMITS.bytes) {
    throw new Error("Document exceeds the 1 MiB canonical JSON limit");
  }
}
