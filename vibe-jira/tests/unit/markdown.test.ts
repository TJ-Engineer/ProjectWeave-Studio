import { describe, expect, it } from "vitest";
import { parseSafeMarkdown } from "@vibe/domain";

describe("safe Markdown", () => {
  it("parses headings, emphasis, code, lists, and safe links", () => {
    expect(
      parseSafeMarkdown(
        "## Details\nUse **care** and `tests`.\n- first\n- [docs](https://example.test/help)",
      ),
    ).toEqual([
      {
        type: "heading",
        level: 2,
        content: [{ type: "text", value: "Details" }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", value: "Use " },
          { type: "strong", value: "care" },
          { type: "text", value: " and " },
          { type: "code", value: "tests" },
          { type: "text", value: "." },
        ],
      },
      {
        type: "list",
        items: [
          [{ type: "text", value: "first" }],
          [
            {
              type: "link",
              value: "docs",
              href: "https://example.test/help",
            },
          ],
        ],
      },
    ]);
  });

  it("never interprets HTML and drops unsafe link targets", () => {
    const blocks = parseSafeMarkdown(
      '<script>alert("x")</script> [click](javascript:alert(1))',
    );
    expect(JSON.stringify(blocks)).toContain("<script>");
    expect(JSON.stringify(blocks)).not.toContain('"type":"link"');
    expect(JSON.stringify(blocks)).not.toContain("javascript:");
  });
});
