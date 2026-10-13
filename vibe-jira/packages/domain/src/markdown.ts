export type SafeMarkdownInline =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; value: string; href: string };

export type SafeMarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; content: SafeMarkdownInline[] }
  | { type: "paragraph"; content: SafeMarkdownInline[] }
  | { type: "list"; items: SafeMarkdownInline[][] };

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function parseSafeMarkdownInline(source: string): SafeMarkdownInline[] {
  const output: SafeMarkdownInline[] = [];
  const pattern =
    /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\))/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index;
    if (index > offset)
      output.push({ type: "text", value: source.slice(offset, index) });
    if (match[2]) output.push({ type: "strong", value: match[2] });
    else if (match[3]) output.push({ type: "code", value: match[3] });
    else if (match[4] && match[5]) {
      const href = safeHref(match[5]);
      output.push(
        href
          ? { type: "link", value: match[4], href }
          : { type: "text", value: match[4] },
      );
    }
    offset = index + match[0].length;
  }
  if (offset < source.length)
    output.push({ type: "text", value: source.slice(offset) });
  return output;
}

export function parseSafeMarkdown(source: string): SafeMarkdownBlock[] {
  const blocks: SafeMarkdownBlock[] = [];
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        content: parseSafeMarkdownInline(heading[2]),
      });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: SafeMarkdownInline[][] = [];
      let cursor = index;
      while (cursor < lines.length && /^[-*]\s+/.test(lines[cursor] ?? "")) {
        items.push(
          parseSafeMarkdownInline(
            (lines[cursor] ?? "").replace(/^[-*]\s+/, ""),
          ),
        );
        cursor += 1;
      }
      blocks.push({ type: "list", items });
      index = cursor - 1;
      continue;
    }
    blocks.push({ type: "paragraph", content: parseSafeMarkdownInline(line) });
  }
  return blocks;
}
