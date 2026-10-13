"use client";

import type { OutboxHealthView } from "@vibe/contracts";
import Link from "next/link";
import { useState } from "react";
import { LogoutButton } from "./logout-button";
import { NotificationLink } from "./notification-link";
import { SearchLink } from "./search-link";

function timestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function OutboxMonitor({
  displayName,
  initialHealth,
}: {
  displayName: string;
  initialHealth: OutboxHealthView;
}) {
  const [health, setHealth] = useState(initialHealth);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/v1/administration/outbox");
      if (!response.ok) throw new Error();
      setHealth((await response.json()) as OutboxHealthView);
    } catch {
      setError("Outbox status could not be refreshed.");
    } finally {
      setPending(false);
    }
  }

  async function retry(eventId: string) {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/v1/administration/outbox/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId }),
      });
      if (!response.ok) throw new Error();
      setHealth((await response.json()) as OutboxHealthView);
      setNotice("The event is queued for another delivery attempt.");
    } catch {
      setError("The dead-lettered event could not be retried.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="page-shell outbox-page">
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
          <h1>Outbox delivery</h1>
          <p className="muted">
            Durable domain-event delivery, retry state, and worker freshness.
          </p>
        </div>
        <div className="toolbar-actions">
          <Link className="secondary-button" href="/administration/settings">
            Settings
          </Link>
          <Link className="secondary-button" href="/administration/audit">
            Audit trail
          </Link>
          <button
            className="secondary-button"
            disabled={pending}
            onClick={() => void refresh()}
            type="button"
          >
            {pending ? "Refreshing…" : "Refresh"}
          </button>
        </div>
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

      <section className="outbox-summary" aria-label="Outbox summary">
        <article>
          <span>Worker</span>
          <strong
            className={`worker-state ${health.worker.state.toLowerCase()}`}
          >
            {health.worker.state.toLocaleLowerCase()}
          </strong>
          <small>Last heartbeat {timestamp(health.worker.lastSeenAt)}</small>
        </article>
        <article>
          <span>Pending</span>
          <strong>{health.pending}</strong>
          <small>Oldest {timestamp(health.oldestPendingAt)}</small>
        </article>
        <article>
          <span>Dead-lettered</span>
          <strong>{health.deadLettered}</strong>
          <small>Requires operator review</small>
        </article>
        <article>
          <span>Delivered last hour</span>
          <strong>{health.deliveredLastHour}</strong>
          <small>Idempotent internal ledger</small>
        </article>
      </section>

      {health.worker.lastError && (
        <p className="error-banner">Worker error: {health.worker.lastError}</p>
      )}

      <section aria-labelledby="outbox-topics-title">
        <h2 id="outbox-topics-title">Queued topics</h2>
        {health.topics.length === 0 ? (
          <p className="empty-state">
            No general outbox events need attention.
          </p>
        ) : (
          <div className="issue-list-table-wrap">
            <table className="issue-list-table">
              <thead>
                <tr>
                  <th scope="col">Topic</th>
                  <th scope="col">Pending</th>
                  <th scope="col">Dead-lettered</th>
                </tr>
              </thead>
              <tbody>
                {health.topics.map((topic) => (
                  <tr key={topic.topic}>
                    <td>{topic.topic}</td>
                    <td>{topic.pending}</td>
                    <td>{topic.deadLettered}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="dead-letters-title">
        <h2 id="dead-letters-title">Dead letters</h2>
        {health.deadLetters.length === 0 ? (
          <p className="empty-state">No delivery failures are quarantined.</p>
        ) : (
          <div className="issue-list-table-wrap">
            <table className="issue-list-table">
              <thead>
                <tr>
                  <th scope="col">Topic</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Failure</th>
                  <th scope="col">Quarantined</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {health.deadLetters.map((event) => (
                  <tr key={event.id}>
                    <td>{event.topic}</td>
                    <td>{event.attempts}</td>
                    <td>{event.lastError}</td>
                    <td>{timestamp(event.deadLetteredAt)}</td>
                    <td>
                      <button
                        className="secondary-button"
                        disabled={pending}
                        onClick={() => void retry(event.id)}
                        type="button"
                      >
                        Retry
                      </button>
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
