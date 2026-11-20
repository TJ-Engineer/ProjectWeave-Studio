import {
  createIssueSchema,
  type CsvValidationError,
  type CsvValidationReport,
  type IssueType,
  type Priority,
} from "@vibe/contracts";

export interface CsvIssueRow {
  row: number;
  summary: string;
  description: string;
  issueType: IssueType;
  priority: Priority;
  labels: string[];
  estimatePoints: number | null;
  dueDate: string | null;
}

function parseRecords(input: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length > 0 || record.length > 0) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  return records.filter((row) => row.some((value) => value.trim()));
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[ _-]+/g, "");
}

export function validateIssueCsv(input: string): {
  report: CsvValidationReport;
  rows: CsvIssueRow[];
} {
  const errors: CsvValidationError[] = [];
  let records: string[][];
  try {
    records = parseRecords(input.replace(/^\uFEFF/, ""));
  } catch (error) {
    return {
      report: {
        totalRows: 0,
        validRows: 0,
        invalidRows: 1,
        errors: [
          {
            row: 1,
            field: "csv",
            message: error instanceof Error ? error.message : "Invalid CSV",
          },
        ],
      },
      rows: [],
    };
  }
  const header = records.shift();
  if (!header) {
    return {
      report: {
        totalRows: 0,
        validRows: 0,
        invalidRows: 1,
        errors: [{ row: 1, field: "csv", message: "CSV is empty" }],
      },
      rows: [],
    };
  }
  const indexes = new Map(
    header.map((value, index) => [normalizeHeader(value), index]),
  );
  const summaryIndex = indexes.get("summary");
  if (summaryIndex === undefined) {
    errors.push({
      row: 1,
      field: "Summary",
      message: "A Summary header is required",
    });
  }
  if (records.length > 1_000) {
    errors.push({
      row: 1,
      field: "csv",
      message: "A single import can contain at most 1,000 rows",
    });
  }
  const rows: CsvIssueRow[] = [];
  if (summaryIndex !== undefined && records.length <= 1_000) {
    for (const [index, record] of records.entries()) {
      const rowNumber = index + 2;
      const rawType =
        record[indexes.get("issuetype") ?? -1]?.trim().toUpperCase() || "TASK";
      const rawPriority =
        record[indexes.get("priority") ?? -1]?.trim().toUpperCase() || "MEDIUM";
      const labels = (record[indexes.get("labels") ?? -1] ?? "")
        .split("|")
        .map((label) => label.trim())
        .filter(Boolean);
      const estimateText =
        record[
          indexes.get("estimatepoints") ?? indexes.get("storypoints") ?? -1
        ]?.trim() ?? "";
      const dueDate = record[indexes.get("duedate") ?? -1]?.trim() ?? "";
      const candidate = createIssueSchema.safeParse({
        summary: record[summaryIndex] ?? "",
        description: record[indexes.get("description") ?? -1] ?? "",
        issueType: rawType,
        priority: rawPriority,
        labels,
        estimatePoints: estimateText ? Number(estimateText) : null,
        dueDate: dueDate || null,
      });
      if (!candidate.success || candidate.data.issueType === "SUBTASK") {
        if (candidate.success) {
          errors.push({
            row: rowNumber,
            field: "Issue Type",
            message:
              "Subtasks require a parent and are not supported by CSV import",
          });
        } else {
          for (const issue of candidate.error.issues) {
            errors.push({
              row: rowNumber,
              field: issue.path.join(".") || "row",
              message: issue.message,
            });
          }
        }
        continue;
      }
      rows.push({
        row: rowNumber,
        summary: candidate.data.summary,
        description: candidate.data.description,
        issueType: candidate.data.issueType,
        priority: candidate.data.priority,
        labels: candidate.data.labels,
        estimatePoints: candidate.data.estimatePoints,
        dueDate: candidate.data.dueDate,
      });
    }
  }
  const invalidRows = new Set(errors.map((error) => error.row));
  return {
    report: {
      totalRows: records.length,
      validRows: rows.length,
      invalidRows: invalidRows.size,
      errors: errors.slice(0, 100),
    },
    rows,
  };
}

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(values: unknown[]): string {
  return values.map(csvCell).join(",");
}
