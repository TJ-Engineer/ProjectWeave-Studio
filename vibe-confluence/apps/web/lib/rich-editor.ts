import {
  Extension,
  Node as TiptapNode,
  mergeAttributes,
  type Extensions,
  type JSONContent,
} from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import {
  CURRENT_SCHEMA_VERSION,
  documentNodeSchema,
  normalizeDocument,
  type BlockNode,
  type CanonicalEditorAdapter,
  type DocumentNode,
  type InlineNode,
  type TextMark,
} from "@knowledge/editor";

export type TiptapDocument = JSONContent;

function attrs(node: JSONContent): Record<string, unknown> {
  return node.attrs ?? {};
}

function requiredString(node: JSONContent, name: string): string {
  const value = attrs(node)[name];
  if (typeof value !== "string") {
    throw new Error(`${node.type ?? "unknown"}.${name} must be a string`);
  }
  return value;
}

function optionalString(node: JSONContent, name: string): string | null {
  const value = attrs(node)[name];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`${node.type ?? "unknown"}.${name} must be a string`);
  }
  return value;
}

function requiredBoolean(node: JSONContent, name: string): boolean {
  const value = attrs(node)[name];
  if (typeof value !== "boolean") {
    throw new Error(`${node.type ?? "unknown"}.${name} must be a boolean`);
  }
  return value;
}

function requiredNumber(node: JSONContent, name: string): number {
  const value = attrs(node)[name];
  if (typeof value !== "number") {
    throw new Error(`${node.type ?? "unknown"}.${name} must be a number`);
  }
  return value;
}

function tiptapMarks(marks: TextMark[]): NonNullable<JSONContent["marks"]> {
  return marks.map((mark) =>
    mark.type === "link"
      ? {
          type: "link",
          attrs: { href: mark.attrs.href, title: mark.attrs.title },
        }
      : { type: mark.type },
  );
}

function canonicalInline(node: InlineNode): JSONContent {
  if (node.type === "text") {
    return { type: "text", text: node.text, marks: tiptapMarks(node.marks) };
  }
  return { type: node.type, attrs: { ...node.attrs } };
}

function canonicalBlock(node: BlockNode): JSONContent {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", content: node.content.map(canonicalInline) };
    case "heading":
      return {
        type: "heading",
        attrs: { level: node.attrs.level },
        content: node.content.map(canonicalInline),
      };
    case "orderedList":
      return {
        type: "orderedList",
        attrs: { start: node.attrs.start },
        content: node.content.map((item) => ({
          type: "listItem",
          content: item.content.map(canonicalBlock),
        })),
      };
    case "unorderedList":
      return {
        type: "bulletList",
        content: node.content.map((item) => ({
          type: "listItem",
          content: item.content.map(canonicalBlock),
        })),
      };
    case "taskList":
      return {
        type: "taskList",
        content: node.content.map((item) => ({
          type: "taskItem",
          attrs: { checked: item.attrs.checked },
          content: item.content.map(canonicalBlock),
        })),
      };
    case "blockquote":
      return { type: "blockquote", content: node.content.map(canonicalBlock) };
    case "divider":
      return { type: "horizontalRule" };
    case "callout":
      return {
        type: "callout",
        attrs: { ...node.attrs },
        content: node.content.map(canonicalBlock),
      };
    case "table":
      return {
        type: "table",
        content: node.content.map((row) => ({
          type: "tableRow",
          content: row.content.map((cell) => ({
            type: cell.attrs.header ? "tableHeader" : "tableCell",
            content: cell.content.map(canonicalBlock),
          })),
        })),
      };
    case "codeBlock":
      return {
        type: "codeBlock",
        attrs: { language: node.attrs.language },
        content: node.code ? [{ type: "text", text: node.code }] : [],
      };
    case "image":
    case "attachment":
      return { type: node.type, attrs: { ...node.attrs } };
    case "expand":
      return {
        type: "expand",
        attrs: { summary: node.attrs.summary },
        content: node.content.map(canonicalBlock),
      };
    case "tableOfContents":
      return { type: "tableOfContents", attrs: { ...node.attrs } };
  }
}

function canonicalDocumentToTiptap(document: DocumentNode): TiptapDocument {
  return {
    type: "doc",
    content: document.content.length
      ? document.content.map(canonicalBlock)
      : [{ type: "paragraph" }],
  };
}

function canonicalMarks(node: JSONContent): TextMark[] {
  return (node.marks ?? []).map((mark) => {
    switch (mark.type) {
      case "bold":
      case "italic":
      case "underline":
      case "strike":
      case "code":
        return { type: mark.type };
      case "link":
        return {
          type: "link",
          attrs: {
            href: requiredString(mark, "href"),
            title: optionalString(mark, "title"),
          },
        };
      default:
        throw new Error(`Unsupported editor mark: ${mark.type ?? "unknown"}`);
    }
  });
}

function tiptapInline(node: JSONContent): InlineNode[] {
  switch (node.type) {
    case "text":
      return [
        {
          type: "text",
          text: node.text ?? "",
          marks: canonicalMarks(node),
        },
      ];
    case "pageLink":
      return [
        {
          type: "pageLink",
          attrs: {
            pageId: requiredString(node, "pageId"),
            label: requiredString(node, "label"),
          },
        },
      ];
    case "userMention":
      return [
        {
          type: "userMention",
          attrs: {
            userId: requiredString(node, "userId"),
            label: requiredString(node, "label"),
          },
        },
      ];
    case "labelReference":
      return [
        {
          type: "labelReference",
          attrs: { label: requiredString(node, "label") },
        },
      ];
    case "date":
      return [
        { type: "date", attrs: { value: requiredString(node, "value") } },
      ];
    case "taskReference":
      return [
        {
          type: "taskReference",
          attrs: {
            taskId: requiredString(node, "taskId"),
            label: requiredString(node, "label"),
          },
        },
      ];
    case "status":
      return [
        {
          type: "status",
          attrs: {
            text: requiredString(node, "text"),
            tone: requiredString(node, "tone") as
              "neutral" | "info" | "success" | "warning" | "danger",
          },
        },
      ];
    default:
      throw new Error(
        `Unsupported inline editor node: ${node.type ?? "unknown"}`,
      );
  }
}

function inlineContent(node: JSONContent): InlineNode[] {
  return (node.content ?? []).flatMap(tiptapInline);
}

function blockContent(node: JSONContent): BlockNode[] {
  return (node.content ?? []).map(tiptapBlock);
}

function tiptapBlock(node: JSONContent): BlockNode {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", content: inlineContent(node) };
    case "heading":
      return {
        type: "heading",
        attrs: {
          level: requiredNumber(node, "level") as 2 | 3 | 4 | 5 | 6,
        },
        content: inlineContent(node),
      };
    case "orderedList":
      return {
        type: "orderedList",
        attrs: { start: requiredNumber(node, "start") },
        content: (node.content ?? []).map((item) => ({
          type: "listItem",
          content: blockContent(item),
        })),
      };
    case "bulletList":
      return {
        type: "unorderedList",
        content: (node.content ?? []).map((item) => ({
          type: "listItem",
          content: blockContent(item),
        })),
      };
    case "taskList":
      return {
        type: "taskList",
        content: (node.content ?? []).map((item) => ({
          type: "taskItem",
          attrs: { checked: requiredBoolean(item, "checked") },
          content: blockContent(item),
        })),
      };
    case "blockquote":
      return { type: "blockquote", content: blockContent(node) };
    case "horizontalRule":
      return { type: "divider" };
    case "callout":
      return {
        type: "callout",
        attrs: {
          tone: requiredString(node, "tone") as
            "info" | "note" | "success" | "warning" | "danger",
          title: optionalString(node, "title"),
        },
        content: blockContent(node),
      };
    case "table":
      return {
        type: "table",
        content: (node.content ?? []).map((row) => ({
          type: "tableRow",
          content: (row.content ?? []).map((cell) => ({
            type: "tableCell",
            attrs: { header: cell.type === "tableHeader" },
            content: blockContent(cell),
          })),
        })),
      };
    case "codeBlock":
      return {
        type: "codeBlock",
        attrs: { language: optionalString(node, "language") },
        code: (node.content ?? [])
          .map((child) => (child.type === "text" ? (child.text ?? "") : ""))
          .join(""),
      };
    case "image":
      return {
        type: "image",
        attrs: {
          assetId: requiredString(node, "assetId"),
          altText: requiredString(node, "altText"),
          caption: optionalString(node, "caption"),
        },
      };
    case "attachment":
      return {
        type: "attachment",
        attrs: {
          assetId: requiredString(node, "assetId"),
          fileName: requiredString(node, "fileName"),
          caption: optionalString(node, "caption"),
        },
      };
    case "expand":
      return {
        type: "expand",
        attrs: { summary: requiredString(node, "summary") },
        content: blockContent(node),
      };
    case "tableOfContents":
      return {
        type: "tableOfContents",
        attrs: {
          minLevel: requiredNumber(node, "minLevel") as 2 | 3 | 4 | 5 | 6,
          maxLevel: requiredNumber(node, "maxLevel") as 2 | 3 | 4 | 5 | 6,
        },
      };
    default:
      throw new Error(
        `Unsupported block editor node: ${node.type ?? "unknown"}`,
      );
  }
}

export const richEditorAdapter: CanonicalEditorAdapter<TiptapDocument> = {
  id: "tiptap-canonical-v2",
  canEdit: () => true,
  toEngine: canonicalDocumentToTiptap,
  toCanonical(document) {
    if (document.type !== "doc") throw new Error("Editor root must be a doc");
    return normalizeDocument(
      documentNodeSchema.parse({
        type: "doc",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        content: (document.content ?? []).map(tiptapBlock),
      }),
    );
  },
};

function inlineAtom(
  name: string,
  selector: string,
  attributes: Record<
    string,
    { default: unknown; parseHTML?: (element: HTMLElement) => unknown }
  >,
  render: (
    attributes: Record<string, unknown>,
  ) => [string, Record<string, string>, string],
) {
  return TiptapNode.create({
    name,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    addAttributes: () => attributes,
    parseHTML: () => [{ tag: selector }],
    renderHTML({ HTMLAttributes }) {
      return render(HTMLAttributes);
    },
  });
}

const PageLink = inlineAtom(
  "pageLink",
  "a[data-page-link]",
  {
    pageId: {
      default: "",
      parseHTML: (element) => element.getAttribute("data-page-id") ?? "",
    },
    label: { default: "Page" },
  },
  (attributes) => [
    "a",
    {
      href: `/pages/${String(attributes.pageId)}`,
      "data-page-link": "true",
      "data-page-id": String(attributes.pageId),
    },
    String(attributes.label),
  ],
);

const UserMention = inlineAtom(
  "userMention",
  "span[data-user-id]",
  { userId: { default: "" }, label: { default: "User" } },
  (attributes) => [
    "span",
    { "data-user-id": String(attributes.userId) },
    `@${String(attributes.label)}`,
  ],
);

const LabelReference = inlineAtom(
  "labelReference",
  "span[data-label-reference]",
  { label: { default: "label" } },
  (attributes) => [
    "span",
    { "data-label-reference": "true" },
    String(attributes.label),
  ],
);

const DateReference = inlineAtom(
  "date",
  "time[datetime]",
  {
    value: {
      default: "",
      parseHTML: (element) => element.getAttribute("datetime") ?? "",
    },
  },
  (attributes) => [
    "time",
    { datetime: String(attributes.value) },
    String(attributes.value),
  ],
);

const TaskReference = inlineAtom(
  "taskReference",
  "span[data-task-id]",
  { taskId: { default: "" }, label: { default: "Task" } },
  (attributes) => [
    "span",
    { "data-task-id": String(attributes.taskId) },
    String(attributes.label),
  ],
);

const Status = inlineAtom(
  "status",
  "span[data-status-tone]",
  { text: { default: "Status" }, tone: { default: "neutral" } },
  (attributes) => [
    "span",
    { "data-status-tone": String(attributes.tone) },
    String(attributes.text),
  ],
);

const Callout = TiptapNode.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      tone: { default: "info" },
      title: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "aside[data-callout-tone]", contentElement: "div" }];
  },
  renderHTML({ HTMLAttributes }) {
    const tone = String(HTMLAttributes.tone ?? "info");
    const title = HTMLAttributes.title;
    return [
      "aside",
      mergeAttributes({ "data-callout-tone": tone }, HTMLAttributes),
      ["strong", { contenteditable: "false" }, String(title ?? "Callout")],
      ["div", 0],
    ];
  },
});

const Expand = TiptapNode.create({
  name: "expand",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      summary: {
        default: "Details",
        parseHTML: (element) =>
          element.querySelector(":scope > summary")?.textContent?.trim() ||
          "Details",
      },
    };
  },
  parseHTML() {
    return [{ tag: "details", contentElement: "div" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "details",
      { open: "", "data-expand": "true" },
      [
        "summary",
        { contenteditable: "false" },
        String(HTMLAttributes.summary ?? "Details"),
      ],
      ["div", 0],
    ];
  },
});

const TableOfContents = TiptapNode.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { minLevel: { default: 2 }, maxLevel: { default: 6 } };
  },
  parseHTML() {
    return [{ tag: "div[data-table-of-contents]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-table-of-contents": "true",
        contenteditable: "false",
      }),
      "Table of contents · generated in preview",
    ];
  },
});

const ImageMetadata = TiptapNode.create({
  name: "image",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      assetId: { default: "" },
      altText: { default: "" },
      caption: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-image-asset-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "figure",
      {
        "data-image-asset-id": String(HTMLAttributes.assetId ?? ""),
        contenteditable: "false",
      },
      `Image: ${String(HTMLAttributes.caption ?? HTMLAttributes.altText ?? "")}`,
    ];
  },
});

const AttachmentMetadata = TiptapNode.create({
  name: "attachment",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      assetId: { default: "" },
      fileName: { default: "" },
      caption: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-attachment-asset-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "figure",
      {
        "data-attachment-asset-id": String(HTMLAttributes.assetId ?? ""),
        contenteditable: "false",
      },
      `Attachment: ${String(HTMLAttributes.fileName ?? "")}`,
    ];
  },
});

export interface PasteSanitizeResult {
  html: string;
  warnings: string[];
}

const allowedPasteElements = new Set([
  "A",
  "B",
  "BLOCKQUOTE",
  "CODE",
  "DEL",
  "DETAILS",
  "EM",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "I",
  "LI",
  "OL",
  "P",
  "PRE",
  "S",
  "STRONG",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "U",
  "UL",
]);

const blockedPasteElements = new Set([
  "AUDIO",
  "BUTTON",
  "EMBED",
  "FORM",
  "IFRAME",
  "INPUT",
  "MATH",
  "OBJECT",
  "SCRIPT",
  "SELECT",
  "STYLE",
  "SVG",
  "TEXTAREA",
  "VIDEO",
]);

function safeExternalHref(value: string): string | null {
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol)
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function sanitizePastedHtml(
  input: string,
  parser: DOMParser = new DOMParser(),
): PasteSanitizeResult {
  const document = parser.parseFromString(input, "text/html");
  const warnings = new Set<string>();

  const clean = (parent: ParentNode) => {
    for (const child of Array.from(parent.childNodes)) {
      if (!(child instanceof Element)) continue;
      const tag = child.tagName.toUpperCase();

      if (tag === "IMG") {
        const alt = child.getAttribute("alt")?.trim();
        child.replaceWith(
          document.createTextNode(
            alt ? `[Image omitted: ${alt}]` : "[Image omitted]",
          ),
        );
        warnings.add(
          "Remote images were replaced with text and were not fetched.",
        );
        continue;
      }

      if (blockedPasteElements.has(tag)) {
        child.remove();
        warnings.add("Unsupported paste formatting was removed.");
        continue;
      }

      clean(child);

      if (!allowedPasteElements.has(tag)) {
        child.replaceWith(...Array.from(child.childNodes));
        warnings.add("Unsupported paste formatting was removed.");
        continue;
      }

      const originalAttributes = Array.from(child.attributes);
      for (const attribute of originalAttributes)
        child.removeAttribute(attribute.name);
      const preservedAttributeNames =
        tag === "A"
          ? new Set(["href", "title"])
          : tag === "OL"
            ? new Set(["start"])
            : new Set<string>();
      if (
        originalAttributes.some(
          (attribute) =>
            !preservedAttributeNames.has(attribute.name.toLowerCase()),
        )
      ) {
        warnings.add("Unsupported paste formatting was removed.");
      }

      if (tag === "A") {
        const href = originalAttributes.find(
          (attribute) => attribute.name.toLowerCase() === "href",
        )?.value;
        const title = originalAttributes.find(
          (attribute) => attribute.name.toLowerCase() === "title",
        )?.value;
        const safeHref = href ? safeExternalHref(href) : null;
        if (safeHref) {
          child.setAttribute("href", safeHref);
          if (title) child.setAttribute("title", title);
        } else if (href) {
          warnings.add("Unsafe links were converted to plain text.");
        }
      }

      if (tag === "OL") {
        const start = originalAttributes.find(
          (attribute) => attribute.name.toLowerCase() === "start",
        )?.value;
        if (start && /^\d{1,7}$/.test(start))
          child.setAttribute("start", start);
      }
    }
  };

  clean(document.body);

  for (const details of Array.from(document.body.querySelectorAll("details"))) {
    const summary = details.querySelector(":scope > summary");
    const content = document.createElement("div");
    for (const child of Array.from(details.childNodes)) {
      if (child !== summary) content.append(child);
    }
    if (!summary) {
      const generatedSummary = document.createElement("summary");
      generatedSummary.textContent = "Details";
      details.prepend(generatedSummary);
      warnings.add(
        "A missing expand summary was replaced with a safe default.",
      );
    }
    details.append(content);
  }

  for (const table of Array.from(document.body.querySelectorAll("table"))) {
    const firstRow = table.querySelector("tr");
    if (!firstRow) continue;
    for (const cell of Array.from(firstRow.children)) {
      if (cell.tagName === "TD") {
        const header = document.createElement("th");
        header.append(...Array.from(cell.childNodes));
        cell.replaceWith(header);
        warnings.add("A header row was added to pasted table content.");
      }
    }
  }

  return { html: document.body.innerHTML, warnings: [...warnings] };
}

interface SafePasteOptions {
  onWarning: (warnings: readonly string[]) => void;
}

const SafePaste = Extension.create<SafePasteOptions>({
  name: "safePaste",
  priority: 1_000,
  addOptions() {
    return { onWarning: () => undefined };
  },
  transformPastedHTML(html) {
    const result = sanitizePastedHtml(html);
    if (result.warnings.length) this.options.onWarning(result.warnings);
    return result.html;
  },
});

export function richEditorExtensions(
  onPasteWarning: (warnings: readonly string[]) => void,
): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3, 4, 5, 6] },
      hardBreak: false,
      link: { openOnClick: false, autolink: false },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    PageLink,
    UserMention,
    LabelReference,
    DateReference,
    TaskReference,
    Status,
    Callout,
    Expand,
    TableOfContents,
    ImageMetadata,
    AttachmentMetadata,
    SafePaste.configure({ onWarning: onPasteWarning }),
  ];
}
