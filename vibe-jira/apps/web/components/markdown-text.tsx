import {
  parseSafeMarkdown,
  type SafeMarkdownInline,
} from "@vibe/domain/markdown";
import { Fragment, type ReactNode } from "react";

function inlines(items: SafeMarkdownInline[]): ReactNode {
  return items.map((item, index) => {
    const key = `${item.type}:${index}`;
    if (item.type === "strong") return <strong key={key}>{item.value}</strong>;
    if (item.type === "code") return <code key={key}>{item.value}</code>;
    if (item.type === "link") {
      return (
        <a key={key} href={item.href} rel="noreferrer noopener" target="_blank">
          {item.value}
        </a>
      );
    }
    return <Fragment key={key}>{item.value}</Fragment>;
  });
}

export function MarkdownText({ source }: { source: string }) {
  const blocks = parseSafeMarkdown(source);
  if (blocks.length === 0) return <p>No description yet.</p>;
  return (
    <div className="markdown-text">
      {blocks.map((block, index) => {
        const key = `${block.type}:${index}`;
        if (block.type === "list") {
          return (
            <ul key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inlines(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "heading") {
          const Heading =
            block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
          return <Heading key={key}>{inlines(block.content)}</Heading>;
        }
        return <p key={key}>{inlines(block.content)}</p>;
      })}
    </div>
  );
}
