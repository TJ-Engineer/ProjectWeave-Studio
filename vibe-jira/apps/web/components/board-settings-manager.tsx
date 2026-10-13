"use client";

import type {
  BoardColumnView,
  BoardSettingsView,
  WorkflowSettingsView,
} from "@vibe/contracts";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./logout-button";
import { NotificationLink } from "./notification-link";
import { SearchLink } from "./search-link";
import { WorkflowSettingsManager } from "./workflow-settings-manager";

function apiMessage(body: unknown, fallback: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return fallback;
}

export function BoardSettingsManager({
  displayName,
  initialView,
  initialWorkflow,
}: {
  displayName: string;
  initialView: BoardSettingsView;
  initialWorkflow: WorkflowSettingsView;
}) {
  const [columns, setColumns] = useState(initialView.columns);
  const [drafts, setDrafts] = useState<Record<string, string>>(
    Object.fromEntries(
      initialView.columns.map((column) => [
        column.id,
        column.wipLimit?.toString() ?? "",
      ]),
    ),
  );
  const [pendingColumnId, setPendingColumnId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function saveColumn(column: BoardColumnView) {
    const raw = drafts[column.id]?.trim() ?? "";
    const wipLimit = raw === "" ? null : Number(raw);
    if (
      wipLimit !== null &&
      (!Number.isInteger(wipLimit) || wipLimit < 1 || wipLimit > 10_000)
    ) {
      setError("WIP limit must be a whole number from 1 to 10,000.");
      return;
    }
    setPendingColumnId(column.id);
    setNotice("");
    setError("");
    try {
      const response = await fetch(
        `/api/v1/projects/${initialView.project.key}/board/columns/${column.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wipLimit, version: column.version }),
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        setError(apiMessage(body, `Could not update ${column.name}.`));
        return;
      }
      const updated = body as BoardColumnView;
      setColumns((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setDrafts((current) => ({
        ...current,
        [updated.id]: updated.wipLimit?.toString() ?? "",
      }));
      setNotice(
        updated.wipLimit === null
          ? `${updated.name} WIP warning disabled.`
          : `${updated.name} WIP limit set to ${updated.wipLimit}.`,
      );
    } catch {
      setError(`Could not update ${column.name}. Try again.`);
    } finally {
      setPendingColumnId(null);
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <div className="board-breadcrumbs">
          <Link className="brand" href="/projects">
            <span>V</span> Vibe JIRA
          </Link>
          <span aria-hidden="true">/</span>
          <Link
            href={`/projects/${initialView.project.key}/boards/${initialView.project.boardId}`}
          >
            {initialView.project.name}
          </Link>
        </div>
        <div className="user-actions">
          <SearchLink />
          <NotificationLink />
          <span>{displayName}</span>
          <LogoutButton />
        </div>
      </header>
      <section
        className="settings-shell"
        aria-labelledby="board-settings-title"
      >
        <div className="settings-heading">
          <div>
            <p className="eyebrow">Project settings</p>
            <h1 id="board-settings-title">Board and workflow</h1>
            <p className="muted">
              Set optional warning thresholds for {initialView.board.name}.
              Limits warn the team without blocking card movement.
            </p>
          </div>
          <Link
            className="secondary-button"
            href={`/projects/${initialView.project.key}/boards/${initialView.project.boardId}`}
          >
            Back to board
          </Link>
        </div>

        <p className="sr-only" aria-live="polite">
          {notice}
        </p>
        {notice && (
          <div className="notice settings-notice" role="status">
            {notice}
          </div>
        )}
        {error && (
          <p className="form-error settings-error" role="alert">
            {error}
          </p>
        )}

        <div className="member-table-wrap">
          <table className="member-table wip-table">
            <caption className="sr-only">
              WIP warning limits for board columns
            </caption>
            <thead>
              <tr>
                <th scope="col">Column</th>
                <th scope="col">Mapped statuses</th>
                <th scope="col">Warning limit</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => {
                const pending = pendingColumnId === column.id;
                const draft = drafts[column.id] ?? "";
                const unchanged =
                  draft.trim() === (column.wipLimit?.toString() ?? "");
                return (
                  <tr key={column.id}>
                    <td>
                      <strong>{column.name}</strong>
                      <small>Position {column.position + 1}</small>
                    </td>
                    <td>
                      {column.statusIds.length} workflow status
                      {column.statusIds.length === 1 ? "" : "es"}
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={`wip-${column.id}`}>
                        WIP limit for {column.name}
                      </label>
                      <input
                        id={`wip-${column.id}`}
                        type="number"
                        min={1}
                        max={10_000}
                        step={1}
                        inputMode="numeric"
                        placeholder="No limit"
                        value={draft}
                        disabled={pending}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [column.id]: event.target.value,
                          }))
                        }
                      />
                      <small>Leave blank to disable the warning.</small>
                    </td>
                    <td>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={pending || unchanged}
                        onClick={() => void saveColumn(column)}
                      >
                        {pending ? "Saving…" : "Save limit"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <WorkflowSettingsManager
          initialView={initialWorkflow}
          onColumnsChanged={(updatedColumns) =>
            setColumns((current) =>
              current.map((column) => ({
                ...column,
                version:
                  updatedColumns.find((item) => item.id === column.id)
                    ?.version ?? column.version,
              })),
            )
          }
        />
      </section>
    </main>
  );
}
