"use client";

import type { DeletedIssuesView, DeletedIssueView } from "@vibe/contracts";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./logout-button";
import { NotificationLink } from "./notification-link";
import { SearchLink } from "./search-link";

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

export function DeletedIssuesManager({
  displayName,
  initialView,
}: {
  displayName: string;
  initialView: DeletedIssuesView;
}) {
  const [issues, setIssues] = useState(initialView.issues);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function restore(issue: DeletedIssueView) {
    setPendingId(issue.id);
    setNotice("");
    setError("");
    try {
      const response = await fetch(`/api/v1/issues/${issue.key}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: issue.version }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setError(apiMessage(body, `Could not restore ${issue.key}.`));
        return;
      }
      setIssues((current) => current.filter((item) => item.id !== issue.id));
      setNotice(`${issue.key} restored to the board.`);
    } catch {
      setError(`Could not restore ${issue.key}. Try again.`);
    } finally {
      setPendingId(null);
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
      <section className="settings-shell" aria-labelledby="deleted-title">
        <div className="settings-heading">
          <div>
            <p className="eyebrow">Project settings</p>
            <h1 id="deleted-title">Deleted issues</h1>
            <p className="muted">
              Restore recoverable work to {initialView.project.name}. Issue keys
              and activity history are preserved.
            </p>
          </div>
          <div className="settings-heading-actions">
            <Link
              className="secondary-button"
              href={`/projects/${initialView.project.key}/settings/members`}
            >
              Manage members
            </Link>
            <Link
              className="secondary-button"
              href={`/projects/${initialView.project.key}/boards/${initialView.project.boardId}`}
            >
              Back to board
            </Link>
          </div>
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

        {issues.length === 0 ? (
          <div className="empty-settings-state">
            <h2>No deleted issues</h2>
            <p className="muted">
              Deleted work will appear here for restoration.
            </p>
          </div>
        ) : (
          <div className="member-table-wrap">
            <table className="member-table">
              <caption className="sr-only">
                Deleted issues in {initialView.project.name}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Issue</th>
                  <th scope="col">Type</th>
                  <th scope="col">Deleted</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue) => {
                  const pending = pendingId === issue.id;
                  return (
                    <tr key={issue.id}>
                      <td>
                        <strong>{issue.summary}</strong>
                        <small>{issue.key}</small>
                      </td>
                      <td>{issue.issueType}</td>
                      <td>
                        {new Date(issue.deletedAt).toLocaleString()}
                        <small>
                          by {issue.deletedBy?.displayName ?? "Unknown user"}
                        </small>
                      </td>
                      <td>
                        <button
                          className="primary-button"
                          type="button"
                          disabled={pending}
                          onClick={() => void restore(issue)}
                        >
                          {pending ? "Restoring…" : "Restore"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
