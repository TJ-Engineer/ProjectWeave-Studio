// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { normalizeDocument, type DocumentNode } from "@knowledge/editor";
import {
  richEditorAdapter,
  richEditorExtensions,
  sanitizePastedHtml,
} from "../../apps/web/lib/rich-editor";
import schemaV2 from "../fixtures/editor/schema-v2.json";
import { describe, expect, it } from "vitest";

describe("rich editor adapter", () => {
  it("round-trips the complete canonical fixture through the actual engine schema", () => {
    const canonical = normalizeDocument(schemaV2 as DocumentNode);
    const engine = new Editor({
      content: richEditorAdapter.toEngine(canonical),
      extensions: richEditorExtensions(() => undefined),
    });

    expect(richEditorAdapter.toCanonical(engine.getJSON())).toEqual(canonical);
    expect(JSON.stringify(engine.getJSON())).not.toContain("schemaVersion");
    engine.destroy();
  });

  it("refuses unknown engine nodes instead of silently dropping them", () => {
    expect(() =>
      richEditorAdapter.toCanonical({
        type: "doc",
        content: [{ type: "unsupportedWidget", attrs: { secret: "keep" } }],
      }),
    ).toThrow(/Unsupported block editor node/);
    expect(() =>
      richEditorAdapter.toCanonical({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "hardBreak" }],
          },
        ],
      }),
    ).toThrow(/Unsupported inline editor node/);
  });
});

describe("paste sanitization", () => {
  it("removes active content, unsafe attributes, and remote images before conversion", () => {
    const result = sanitizePastedHtml(`
      <script>window.evil = true</script>
      <p onclick="evil()" style="color:red"><strong>Safe</strong></p>
      <img src="https://tracker.example/pixel" alt="Architecture diagram">
      <a href="javascript:alert(1)" onmouseover="evil()">unsafe link</a>
      <iframe src="https://example.test/embed"></iframe>
    `);

    expect(result.html).toContain("<strong>Safe</strong>");
    expect(result.html).toContain("[Image omitted: Architecture diagram]");
    expect(result.html).toContain("unsafe link");
    expect(result.html).not.toMatch(
      /script|iframe|<img|onclick|onmouseover|style=|javascript:/i,
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Remote images were replaced with text and were not fetched.",
        "Unsupported paste formatting was removed.",
        "Unsafe links were converted to plain text.",
      ]),
    );
  });

  it("keeps allowlisted semantic HTML and normalizes a table header row", () => {
    const result = sanitizePastedHtml(`
      <h2>Release plan</h2>
      <table><tbody><tr><td>Owner</td><td>State</td></tr><tr><td>Ada</td><td>Ready</td></tr></tbody></table>
      <p><a href="https://example.test/guide" title="Guide">Reference</a></p>
    `);

    expect(result.html).toContain("<h2>Release plan</h2>");
    expect(result.html).toContain("<th>Owner</th><th>State</th>");
    expect(result.html).toContain('href="https://example.test/guide"');
    expect(result.warnings).toContain(
      "A header row was added to pasted table content.",
    );
  });

  it("does not warn when supported link attributes are preserved unchanged", () => {
    const result = sanitizePastedHtml(
      '<p><a href="https://example.test/guide" title="Guide">Reference</a></p>',
    );

    expect(result.html).toContain('href="https://example.test/guide"');
    expect(result.html).toContain('title="Guide"');
    expect(result.warnings).toEqual([]);
  });

  it("preserves semantic details as a canonical expand block", () => {
    const result = sanitizePastedHtml(
      "<details><summary>Runbook</summary><p>Follow the steps.</p></details>",
    );
    const engine = new Editor({
      content: result.html,
      extensions: richEditorExtensions(() => undefined),
    });
    const canonical = richEditorAdapter.toCanonical(engine.getJSON());

    expect(result.warnings).toEqual([]);
    expect(canonical.content[0]).toEqual({
      type: "expand",
      attrs: { summary: "Runbook" },
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Follow the steps.", marks: [] }],
        },
      ],
    });
    engine.destroy();
  });
});
