"use client";

import type { AuditEventsView } from "@vibe/contracts";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./logout-button";
import { NotificationLink } from "./notification-link";
import { SearchLink } from "./search-link";

interface Filters {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  correlationId: string;
  from: string;
  to: string;
}

const emptyFilters: Filters = {
  actorId: "",
  action: "",
  targetType: "",
  targetId: "",
  correlationId: "",
  from: "",
  to: "",
};

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

function parameters(filters: Filters, cursor?: string): URLSearchParams {
  const result = new URLSearchParams({ limit: "50" });
  for (const [key, value] of Object.entries(filters)) {
    if (value) result.set(key, value);
  }
  if (cursor) result.set("cursor", cursor);
  return result;
}

export function AuditLog({
  displayName,
  initialView,
}: {
  displayName: string;
  initialView: AuditEventsView;
}) {
  const [view, setView] = useState(initialView);
  const [draftFilters, setDraftFilters] = useState(emptyFilters);
  const [activeFilters, setActiveFilters] = useState(emptyFilters);
  const [retentionDays, setRetentionDays] = useState(
    initialView.retention.days.toString(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function updateFilter(name: keyof Filters, value: string) {
    setDraftFilters((current) => ({ ...current, [name]: value }));
  }

  async function fetchEvents(filters: Filters, cursor?: string) {
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/administration/audit?${parameters(filters, cursor)}`,
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(body, "Could not load audit events."));
      }
      const updated = body as AuditEventsView;
      setView((current) =>
        cursor
          ? { ...updated, items: [...current.items, ...updated.items] }
          : updated,
      );
      if (!cursor) setActiveFilters(filters);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not load audit events.",
      );
    } finally {
      setPending(false);
    }
  }

  async function saveRetention() {
    const days = Number(retentionDays);
    if (!Number.isInteger(days) || days < 30 || days > 3650) {
      setError("Retention must be a whole number from 30 to 3,650 days.");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/v1/administration/audit", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days, version: view.retention.version }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiMessage(body, "Could not update audit retention."));
      }
      const retention = body as AuditEventsView["retention"];
      setView((current) => ({ ...current, retention }));
      setRetentionDays(retention.days.toString());
      setNotice(`Audit events will be retained for ${retention.days} days.`);
      await fetchEvents(activeFilters);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not update audit retention.",
      );
      setPending(false);
    }
  }

  return (
    <main className="page-shell audit-page">
      <header className="topbar">
        <Link className="brand" href="/projects">
          <span>V</span> Vibe JIRA
        </Link>
        <div className="user-actions">
          <SearchLink />
          <NotificationLink />
          <span>{displayName}</span>
          <LogoutButton />
        </div>
      </header>
      <section className="administration-heading">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Audit trail</h1>
          <p className="muted">
            Immutable, correlated evidence for organization mutations.
          </p>
        </div>
        <nav className="toolbar-actions" aria-label="Administration sections">
          <Link className="secondary-button" href="/administration/settings">
            Settings
          </Link>
          <Link className="secondary-button" href="/administration/outbox">
            Outbox
          </Link>
        </nav>
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

      <section className="audit-retention" aria-labelledby="retention-title">
        <div>
          <h2 id="retention-title">Retention</h2>
          <p className="muted">
            The outbox worker removes events older than this policy every hour.
          </p>
        </div>
        <label>
          Days
          <input
            disabled={pending}
            max={3650}
            min={30}
            onChange={(event) => setRetentionDays(event.target.value)}
            type="number"
            value={retentionDays}
          />
        </label>
        <button
          className="secondary-button"
          disabled={pending || retentionDays === view.retention.days.toString()}
          onClick={() => void saveRetention()}
          type="button"
        >
          Save retention
        </button>
      </section>

      <form
        className="audit-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void fetchEvents(draftFilters);
        }}
      >
        <label>
          Actor
          <select
            disabled={pending}
            onChange={(event) => updateFilter("actorId", event.target.value)}
            value={draftFilters.actorId}
          >
            <option value="">All actors</option>
            {view.facets.actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.displayName} ({actor.email})
              </option>
            ))}
          </select>
        </label>
        <label>
          Action
          <input
            disabled={pending}
            list="audit-actions"
            onChange={(event) => updateFilter("action", event.target.value)}
            value={draftFilters.action}
          />
          <datalist id="audit-actions">
            {view.facets.actions.map((action) => (
              <option key={action} value={action} />
            ))}
          </datalist>
        </label>
        <label>
          Target type
          <select
            disabled={pending}
            onChange={(event) => updateFilter("targetType", event.target.value)}
            value={draftFilters.targetType}
          >
            <option value="">All target types</option>
            {view.facets.targetTypes.map((targetType) => (
              <option key={targetType} value={targetType}>
                {targetType}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target ID
          <input
            disabled={pending}
            onChange={(event) => updateFilter("targetId", event.target.value)}
            placeholder="UUID"
            value={draftFilters.targetId}
          />
        </label>
        <label>
          Correlation ID
          <input
            disabled={pending}
            onChange={(event) =>
              updateFilter("correlationId", event.target.value)
            }
            placeholder="UUID"
            value={draftFilters.correlationId}
          />
        </label>
        <label>
          From
          <input
            disabled={pending}
            onChange={(event) => updateFilter("from", event.target.value)}
            type="date"
            value={draftFilters.from}
          />
        </label>
        <label>
          To
          <input
            disabled={pending}
            onChange={(event) => updateFilter("to", event.target.value)}
            type="date"
            value={draftFilters.to}
          />
        </label>
        <div className="toolbar-actions">
          <button className="primary-button" disabled={pending} type="submit">
            Apply filters
          </button>
          <button
            className="secondary-button"
            disabled={pending}
            onClick={() => {
              setDraftFilters(emptyFilters);
              void fetchEvents(emptyFilters);
            }}
            type="button"
          >
            Clear
          </button>
        </div>
      </form>

      <section aria-labelledby="audit-events-title">
        <h2 id="audit-events-title">Events</h2>
        {view.items.length === 0 ? (
          <p className="empty-state">No audit events match these filters.</p>
        ) : (
          <div className="issue-list-table-wrap">
            <table className="issue-list-table audit-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Target</th>
                  <th scope="col">Correlation</th>
                  <th scope="col">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {view.items.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.createdAt).toLocaleString()}</td>
                    <td>
                      {event.actor.displayName}
                      <small>{event.actor.email}</small>
                    </td>
                    <td>
                      <code>{event.action}</code>
                    </td>
                    <td>
                      {event.targetType}
                      <small>{event.targetId}</small>
                    </td>
                    <td>
                      <code>{event.correlationId}</code>
                    </td>
                    <td>
                      <details>
                        <summary>View</summary>
                        <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {view.nextCursor && (
          <button
            className="secondary-button load-more-button"
            disabled={pending}
            onClick={() => void fetchEvents(activeFilters, view.nextCursor!)}
            type="button"
          >
            {pending ? "Loading…" : "Load 50 more"}
          </button>
        )}
      </section>
    </main>
  );
}
