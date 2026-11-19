"use client";

import type { KanbanReportsView } from "@vibe/contracts";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./logout-button";
import { NotificationLink } from "./notification-link";
import { SearchLink } from "./search-link";

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const days = seconds / 86_400;
  if (days >= 1) return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
  const hours = seconds / 3_600;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(seconds / 60)}m`;
}

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

export function ReportsDashboard({
  displayName,
  initialView,
}: {
  displayName: string;
  initialView: KanbanReportsView;
}) {
  const [view, setView] = useState(initialView);
  const [from, setFrom] = useState(initialView.period.from);
  const [to, setTo] = useState(initialView.period.to);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function applyPeriod() {
    setPending(true);
    setError("");
    try {
      const query = new URLSearchParams({ from, to });
      const response = await fetch(
        `/api/v1/projects/${view.project.key}/reports?${query}`,
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(body, "Reports could not be loaded."));
      }
      setView(body as KanbanReportsView);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Reports could not be loaded.",
      );
    } finally {
      setPending(false);
    }
  }

  const maxThroughput = Math.max(
    1,
    ...view.throughput.map((point) => point.count),
  );
  const maxFlow = Math.max(
    1,
    ...view.cumulativeFlow.map(
      (point) => point.todo + point.inProgress + point.done,
    ),
  );

  return (
    <main className="page-shell reports-page">
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
          <p className="eyebrow">Project reports · UTC</p>
          <h1>Kanban flow</h1>
          <p className="muted">
            Event-derived delivery metrics using the published Release 1
            definitions.
          </p>
        </div>
        <Link className="secondary-button" href="/docs/metrics">
          Metric definitions
        </Link>
      </section>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <section className="report-period" aria-label="Report period">
        <label>
          From
          <input
            disabled={pending}
            onChange={(event) => setFrom(event.target.value)}
            type="date"
            value={from}
          />
        </label>
        <label>
          To
          <input
            disabled={pending}
            onChange={(event) => setTo(event.target.value)}
            type="date"
            value={to}
          />
        </label>
        <button
          className="primary-button"
          disabled={pending}
          onClick={() => void applyPeriod()}
          type="button"
        >
          {pending ? "Loading…" : "Apply period"}
        </button>
      </section>

      <section className="report-summary" aria-label="Flow summary">
        <article>
          <span>Throughput</span>
          <strong>{view.summary.throughput}</strong>
          <small>first completions</small>
        </article>
        <article>
          <span>Average lead time</span>
          <strong>{duration(view.summary.averageLeadTimeSeconds)}</strong>
          <small>created → first done</small>
        </article>
        <article>
          <span>Average cycle time</span>
          <strong>{duration(view.summary.averageCycleTimeSeconds)}</strong>
          <small>first progress → first done</small>
        </article>
        <article>
          <span>Aging WIP</span>
          <strong>{view.summary.activeWip}</strong>
          <small>average {duration(view.summary.averageWipAgeSeconds)}</small>
        </article>
      </section>

      <section className="report-grid">
        <article className="report-panel" aria-labelledby="throughput-title">
          <h2 id="throughput-title">Throughput</h2>
          <div
            className="bar-chart"
            aria-label="Daily throughput chart"
            tabIndex={0}
          >
            {view.throughput.map((point) => (
              <div key={point.date}>
                <span>{point.date.slice(5)}</span>
                <i
                  aria-hidden="true"
                  style={{ width: `${(point.count / maxThroughput) * 100}%` }}
                />
                <strong>{point.count}</strong>
              </div>
            ))}
          </div>
        </article>
        <article className="report-panel" aria-labelledby="cfd-title">
          <h2 id="cfd-title">Cumulative flow</h2>
          <div
            className="flow-chart"
            aria-label="Cumulative flow chart"
            tabIndex={0}
          >
            {view.cumulativeFlow.map((point) => (
              <div key={point.date}>
                <span>{point.date.slice(5)}</span>
                <span className="flow-stack" aria-hidden="true">
                  <i
                    className="todo"
                    style={{ width: `${(point.todo / maxFlow) * 100}%` }}
                  />
                  <i
                    className="progress"
                    style={{ width: `${(point.inProgress / maxFlow) * 100}%` }}
                  />
                  <i
                    className="done"
                    style={{ width: `${(point.done / maxFlow) * 100}%` }}
                  />
                </span>
                <strong>
                  {point.todo}/{point.inProgress}/{point.done}
                </strong>
              </div>
            ))}
          </div>
          <p className="chart-legend">
            <span className="todo">To do</span>
            <span className="progress">In progress</span>
            <span className="done">Done</span>
          </p>
        </article>
      </section>

      <section className="report-grid">
        <article className="report-panel" aria-labelledby="trend-title">
          <h2 id="trend-title">Created versus resolved</h2>
          <div className="issue-list-table-wrap">
            <table className="issue-list-table">
              <thead>
                <tr>
                  <th scope="col">UTC date</th>
                  <th scope="col">Created</th>
                  <th scope="col">Resolved</th>
                </tr>
              </thead>
              <tbody>
                {view.createdResolved.map((point) => (
                  <tr key={point.date}>
                    <td>{point.date}</td>
                    <td>{point.created}</td>
                    <td>{point.resolved}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
        <article className="report-panel" aria-labelledby="status-time-title">
          <h2 id="status-time-title">Average status-category time</h2>
          <dl className="status-time-list">
            {view.statusTime.map((item) => (
              <div key={item.category}>
                <dt>{item.category.replace("_", " ").toLocaleLowerCase()}</dt>
                <dd>{duration(item.averageSeconds)}</dd>
              </div>
            ))}
          </dl>
        </article>
      </section>

      <section className="report-panel" aria-labelledby="aging-title">
        <h2 id="aging-title">Aging work in progress</h2>
        {view.agingWip.length === 0 ? (
          <p className="empty-state">No issues are currently in progress.</p>
        ) : (
          <div className="issue-list-table-wrap">
            <table className="issue-list-table">
              <thead>
                <tr>
                  <th scope="col">Issue</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Age</th>
                </tr>
              </thead>
              <tbody>
                {view.agingWip.map((issue) => (
                  <tr key={issue.issueId}>
                    <td>
                      <Link
                        href={`/projects/${view.project.key}/boards/${view.project.boardId}?issue=${issue.issueKey}`}
                      >
                        {issue.issueKey}
                      </Link>
                    </td>
                    <td>{issue.summary}</td>
                    <td>{duration(issue.ageSeconds)}</td>
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
