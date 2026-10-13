import { describe, expect, it } from "vitest";
import { csvLine, validateIssueCsv } from "@vibe/database";

describe("CSV portability", () => {
  it("parses quoted Jira-style rows and reports invalid rows deterministically", () => {
    const csv = [
      "Summary,Description,Issue Type,Priority,Labels",
      '"Valid, quoted","Line one\nLine two",Bug,HIGH,customer|urgent',
      "Missing type support,,Subtask,MEDIUM,",
      ",,Task,LOW,",
    ].join("\r\n");
    const result = validateIssueCsv(csv);
    expect(result.report).toMatchObject({
      totalRows: 3,
      validRows: 1,
      invalidRows: 2,
    });
    expect(result.rows[0]).toMatchObject({
      row: 2,
      summary: "Valid, quoted",
      description: "Line one\nLine two",
      issueType: "BUG",
      priority: "HIGH",
      labels: ["customer", "urgent"],
    });
  });

  it("escapes export cells using RFC 4180 quoting", () => {
    expect(csvLine(["ENG-1", 'A "quoted", value', "line one\nline two"])).toBe(
      'ENG-1,"A ""quoted"", value","line one\nline two"',
    );
  });
});
