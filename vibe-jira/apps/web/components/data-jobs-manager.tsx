"use client";

import type {
  CsvImportPolicy,
  CsvValidationReport,
  DataJobsView,
} from "@vibe/contracts";
import Link from "next/link";
import { useRef, useState } from "react";
import { LogoutButton } from "./logout-button";
import { NotificationLink } from "./notification-link";
import { SearchLink } from "./search-link";

const exampleCsv = `Summary,Description,Issue Type,Priority,Labels
Imported task,Created from CSV,TASK,MEDIUM,import|planning`;

function apiMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return fallback;
}

export function DataJobsManager({
  displayName,
  initialView,
}: {
  displayName: string;
  initialView: DataJobsView;
}) {
  const [view, setView] = useState(initialView);
  const [csv, setCsv] = useState(exampleCsv);
  const [policy, setPolicy] = useState<CsvImportPolicy>("ATOMIC");
  const [report, setReport] = useState<CsvValidationReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const importKey = useRef<string | null>(null);
  const exportKey = useRef<string | null>(null);

  async function refresh() {
    const response = await fetch(
      `/api/v1/projects/${view.project.key}/data-jobs`,
    );
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new Error(apiMessage(body, "Could not refresh data jobs."));
    }
    setView(body as DataJobsView);
  }

  async function dryRun() {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/v1/projects/${view.project.key}/data-jobs/import/dry-run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ csv }),
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(body, "CSV validation failed."));
      }
      const validation = body as CsvValidationReport;
      setReport(validation);
      setNotice(
        `${validation.validRows} valid and ${validation.invalidRows} invalid rows.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "CSV validation failed.",
      );
    } finally {
      setPending(false);
    }
  }

  async function enqueueImport() {
    setPending(true);
    setError("");
    setNotice("");
    importKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch(
        `/api/v1/projects/${view.project.key}/data-jobs/import`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": importKey.current,
          },
          body: JSON.stringify({ csv, invalidRowPolicy: policy }),
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(body, "CSV import could not be queued."));
      }
      importKey.current = null;
      await refresh();
      setNotice("CSV import queued and processed by the background worker.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "CSV import could not be queued.",
      );
    } finally {
      setPending(false);
    }
  }

  async function enqueueExport() {
    setPending(true);
    setError("");
    setNotice("");
    exportKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch(
        `/api/v1/projects/${view.project.key}/data-jobs/export`,
        {
          method: "POST",
          headers: { "idempotency-key": exportKey.current },
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(body, "CSV export could not be queued."));
      }
      exportKey.current = null;
      await refresh();
      setNotice("CSV export queued and processed by the background worker.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "CSV export could not be queued.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="page-shell data-jobs-page">
      <header className="topbar">
        <div className="board-breadcrumbs">
          <Link className="brand" href="/projects">
            <span>V</span> Vibe JIRA
          </Link>
          <span aria-hidden="true">/</span>
          <Link
            href={`/projects/${view.project.key}/boards/${view.project.boardId}`}
          >
            {view.project.name}
          </Link>
        </div>
        <div className="user-actions">
          <SearchLink />
          <NotificationLink />
          <span>{displayName}</span>
          <LogoutButton />
        </div>
      </header>
      <section className="settings-heading">
        <div>
          <p className="eyebrow">Project settings</p>
          <h1>Import and export</h1>
          <p className="muted">
            Validate imports before queueing durable background jobs.
          </p>
        </div>
        <Link
          className="secondary-button"
          href={`/projects/${view.project.key}/boards/${view.project.boardId}`}
        >
          Back to board
        </Link>
      </section>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-banner" aria-live="polite">
          {notice}
        </p>
      )}

      <section className="data-job-grid">
        <div className="data-job-panel">
          <h2>CSV import</h2>
          <p className="muted">
            Headers: Summary, Description, Issue Type, Priority, Labels.
            Separate labels with <code>|</code>.
          </p>
          <label>
            Choose CSV file
            <input
              accept=".csv,text/csv"
              disabled={pending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void file.text().then(setCsv);
              }}
              type="file"
            />
          </label>
          <label>
            CSV data
            <textarea
              disabled={pending}
              onChange={(event) => {
                setCsv(event.target.value);
                setReport(null);
                importKey.current = null;
              }}
              rows={9}
              value={csv}
            />
          </label>
          <label>
            Invalid-row policy
            <select
              disabled={pending}
              onChange={(event) =>
                setPolicy(event.target.value as CsvImportPolicy)
              }
              value={policy}
            >
              <option value="ATOMIC">Reject the complete file</option>
              <option value="SKIP_INVALID">Import valid rows only</option>
            </select>
          </label>
          <div className="toolbar-actions">
            <button
              className="secondary-button"
              disabled={pending || !csv}
              onClick={() => void dryRun()}
              type="button"
            >
              Dry run
            </button>
            <button
              className="primary-button"
              disabled={pending || !csv}
              onClick={() => void enqueueImport()}
              type="button"
            >
              Queue import
            </button>
          </div>
          {report && (
            <div className="validation-report" aria-label="Validation report">
              <strong>
                {report.validRows} valid / {report.invalidRows} invalid
              </strong>
              {report.errors.length > 0 && (
                <ul>
                  {report.errors.map((item, index) => (
                    <li key={`${item.row}:${item.field}:${index}`}>
                      Row {item.row}, {item.field}: {item.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="data-job-panel">
          <h2>CSV export</h2>
          <p className="muted">
            Export every active and deleted issue with workflow and timestamp
            fields using RFC 4180 escaping.
          </p>
          <button
            className="primary-button"
            disabled={pending}
            onClick={() => void enqueueExport()}
            type="button"
          >
            Queue export
          </button>
        </div>
      </section>

      <section aria-labelledby="data-jobs-title">
        <div className="workflow-heading">
          <h2 id="data-jobs-title">Recent jobs</h2>
          <button
            className="secondary-button"
            disabled={pending}
            onClick={() =>
              void refresh().catch(() =>
                setError("Could not refresh data jobs."),
              )
            }
            type="button"
          >
            Refresh
          </button>
        </div>
        {view.jobs.length === 0 ? (
          <p className="empty-state">No import or export jobs yet.</p>
        ) : (
          <div className="issue-list-table-wrap">
            <table className="issue-list-table">
              <thead>
                <tr>
                  <th scope="col">Created</th>
                  <th scope="col">Type</th>
                  <th scope="col">State</th>
                  <th scope="col">Result</th>
                  <th scope="col">Download</th>
                </tr>
              </thead>
              <tbody>
                {view.jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{new Date(job.createdAt).toLocaleString()}</td>
                    <td>
                      {job.jobType === "CSV_IMPORT" ? "Import" : "Export"}
                    </td>
                    <td>{job.state.toLocaleLowerCase()}</td>
                    <td>{job.errorMessage ?? JSON.stringify(job.result)}</td>
                    <td>
                      {job.canDownload ? (
                        <a
                          className="secondary-button"
                          href={`/api/v1/projects/${view.project.key}/data-jobs/${job.id}/download`}
                        >
                          Download CSV
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
