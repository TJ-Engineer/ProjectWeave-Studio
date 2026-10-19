import {
  type BlockNode,
  type DocumentNode,
  type InlineNode,
  type TextNode,
  documentNodeSchema,
} from "./schema";
import type { FutureDocumentProjection } from "./compatibility";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function textFromInline(content: InlineNode[]): string {
  return content
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "pageLink":
        case "userMention":
        case "taskReference":
          return node.attrs.label;
        case "labelReference":
          return node.attrs.label;
        case "date":
          return node.attrs.value;
        case "status":
          return node.attrs.text;
      }
    })
    .join("");
}

function renderText(node: TextNode): string {
  let html = escapeHtml(node.text);
  for (const mark of node.marks) {
    switch (mark.type) {
      case "bold":
        html = `<strong>${html}</strong>`;
        break;
      case "italic":
        html = `<em>${html}</em>`;
        break;
      case "underline":
        html = `<u>${html}</u>`;
        break;
      case "strike":
        html = `<s>${html}</s>`;
        break;
      case "code":
        html = `<code>${html}</code>`;
        break;
      case "link":
        html = `<a href="${escapeHtml(mark.attrs.href)}"${
          mark.attrs.title ? ` title="${escapeHtml(mark.attrs.title)}"` : ""
        } rel="nofollow noopener noreferrer">${html}</a>`;
        break;
    }
  }
  return html;
}

function renderInline(node: InlineNode): string {
  switch (node.type) {
    case "text":
      return renderText(node);
    case "pageLink":
      return `<a href="/pages/${escapeHtml(node.attrs.pageId)}" data-page-link="true">${escapeHtml(node.attrs.label)}</a>`;
    case "userMention":
      return `<span data-user-id="${escapeHtml(node.attrs.userId)}">@${escapeHtml(node.attrs.label)}</span>`;
    case "labelReference":
      return `<span data-label-reference="true">${escapeHtml(node.attrs.label)}</span>`;
    case "date":
      return `<time datetime="${escapeHtml(node.attrs.value)}">${escapeHtml(node.attrs.value)}</time>`;
    case "taskReference":
      return `<span data-task-id="${escapeHtml(node.attrs.taskId)}">${escapeHtml(node.attrs.label)}</span>`;
    case "status":
      return `<span data-status-tone="${node.attrs.tone}">${escapeHtml(node.attrs.text)}</span>`;
  }
}

function renderInlineContent(content: InlineNode[]): string {
  return content.map(renderInline).join("");
}

interface HeadingEntry {
  level: number;
  label: string;
  id: string;
}

function headingEntries(document: DocumentNode): HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  const visit = (blocks: BlockNode[]) => {
    for (const block of blocks) {
      switch (block.type) {
        case "heading":
          entries.push({
            level: block.attrs.level,
            label: textFromInline(block.content),
            id: `heading-${entries.length + 1}`,
          });
          break;
        case "orderedList":
        case "unorderedList":
        case "taskList":
          for (const item of block.content) visit(item.content);
          break;
        case "blockquote":
        case "callout":
        case "expand":
          visit(block.content);
          break;
        case "table":
          for (const row of block.content) {
            for (const cell of row.content) visit(cell.content);
          }
          break;
        case "paragraph":
        case "divider":
        case "codeBlock":
        case "image":
        case "attachment":
        case "tableOfContents":
          break;
      }
    }
  };
  visit(document.content);
  return entries;
}

interface RenderContext {
  headings: HeadingEntry[];
  headingIndex: number;
}

function renderBlocks(blocks: BlockNode[], context: RenderContext): string {
  const renderBlock = (block: BlockNode): string => {
    switch (block.type) {
      case "paragraph":
        return `<p>${renderInlineContent(block.content)}</p>`;
      case "heading": {
        const heading = context.headings[context.headingIndex];
        context.headingIndex += 1;
        return `<h${block.attrs.level} id="${heading?.id ?? `heading-${context.headingIndex}`}">${renderInlineContent(block.content)}</h${block.attrs.level}>`;
      }
      case "orderedList":
        return `<ol start="${block.attrs.start}">${block.content
          .map((item) => `<li>${renderBlocks(item.content, context)}</li>`)
          .join("")}</ol>`;
      case "unorderedList":
        return `<ul>${block.content
          .map((item) => `<li>${renderBlocks(item.content, context)}</li>`)
          .join("")}</ul>`;
      case "taskList":
        return `<ul data-task-list="true">${block.content
          .map(
            (item) =>
              `<li data-checked="${item.attrs.checked}">${renderBlocks(item.content, context)}</li>`,
          )
          .join("")}</ul>`;
      case "blockquote":
        return `<blockquote>${renderBlocks(block.content, context)}</blockquote>`;
      case "divider":
        return "<hr>";
      case "callout":
        return `<aside data-callout-tone="${block.attrs.tone}">${
          block.attrs.title
            ? `<strong>${escapeHtml(block.attrs.title)}</strong>`
            : ""
        }${renderBlocks(block.content, context)}</aside>`;
      case "table":
        return `<table><tbody>${block.content
          .map(
            (row) =>
              `<tr>${row.content
                .map((cell) => {
                  const tag = cell.attrs.header ? "th" : "td";
                  const scope = cell.attrs.header ? ' scope="col"' : "";
                  return `<${tag}${scope}>${renderBlocks(cell.content, context)}</${tag}>`;
                })
                .join("")}</tr>`,
          )
          .join("")}</tbody></table>`;
      case "codeBlock":
        return `<pre><code${
          block.attrs.language
            ? ` data-language="${escapeHtml(block.attrs.language)}"`
            : ""
        }>${escapeHtml(block.code)}</code></pre>`;
      case "image":
        return `<figure data-image-asset-id="${escapeHtml(block.attrs.assetId)}"><span role="img" aria-label="${escapeHtml(block.attrs.altText)}"></span>${
          block.attrs.caption
            ? `<figcaption>${escapeHtml(block.attrs.caption)}</figcaption>`
            : ""
        }</figure>`;
      case "attachment":
        return `<figure data-attachment-asset-id="${escapeHtml(block.attrs.assetId)}"><span>${escapeHtml(block.attrs.fileName)}</span>${
          block.attrs.caption
            ? `<figcaption>${escapeHtml(block.attrs.caption)}</figcaption>`
            : ""
        }</figure>`;
      case "expand":
        return `<details><summary>${escapeHtml(block.attrs.summary)}</summary>${renderBlocks(block.content, context)}</details>`;
      case "tableOfContents":
        return `<nav aria-label="Table of contents"><ol>${context.headings
          .filter(
            (heading) =>
              heading.level >= block.attrs.minLevel &&
              heading.level <= block.attrs.maxLevel,
          )
          .map(
            (heading) =>
              `<li data-heading-level="${heading.level}"><a href="#${heading.id}">${escapeHtml(heading.label)}</a></li>`,
          )
          .join("")}</ol></nav>`;
    }
  };
  return blocks.map(renderBlock).join("");
}

function blockPlainText(block: BlockNode): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return textFromInline(block.content);
    case "orderedList":
    case "unorderedList":
      return block.content
        .map((item) => item.content.map(blockPlainText).join("\n"))
        .join("\n");
    case "taskList":
      return block.content
        .map(
          (item) =>
            `${item.attrs.checked ? "[x]" : "[ ]"} ${item.content
              .map(blockPlainText)
              .join("\n")}`,
        )
        .join("\n");
    case "blockquote":
    case "callout":
    case "expand":
      return block.content.map(blockPlainText).join("\n");
    case "divider":
      return "";
    case "table":
      return block.content
        .map((row) =>
          row.content
            .map((cell) => cell.content.map(blockPlainText).join(" "))
            .join("\t"),
        )
        .join("\n");
    case "codeBlock":
      return block.code;
    case "image":
      return block.attrs.caption ?? block.attrs.altText;
    case "attachment":
      return block.attrs.caption ?? block.attrs.fileName;
    case "tableOfContents":
      return "";
  }
}

export function extractPlainText(input: DocumentNode): string {
  return documentNodeSchema
    .parse(input)
    .content.map(blockPlainText)
    .filter(Boolean)
    .join("\n");
}

export function renderDocumentToHtml(input: DocumentNode): string {
  const document = documentNodeSchema.parse(input);
  return renderBlocks(document.content, {
    headings: headingEntries(document),
    headingIndex: 0,
  });
}

export function renderFutureDocumentToHtml(
  document: FutureDocumentProjection,
): string {
  return document.content
    .map(
      (node) =>
        `<div data-unsupported-node="${escapeHtml(node.originalType)}">Unsupported content from schema version ${document.schemaVersion}</div>`,
    )
    .join("");
}
