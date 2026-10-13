"use client";

import type {
  NotificationCenterView,
  NotificationPreferences,
  NotificationView,
} from "@vibe/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogoutButton } from "./logout-button";
import { SearchLink } from "./search-link";

function message(notification: NotificationView): string {
  return notification.eventClass === "MENTION"
    ? `${notification.actor.displayName} mentioned you`
    : `${notification.actor.displayName} commented on a watched issue`;
}

export function NotificationCenter({
  displayName,
  initialCenter,
}: {
  displayName: string;
  initialCenter: NotificationCenterView;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialCenter.items);
  const [nextCursor, setNextCursor] = useState(initialCenter.nextCursor);
  const [unreadCount, setUnreadCount] = useState(initialCenter.unreadCount);
  const [preferences, setPreferences] = useState(initialCenter.preferences);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function openNotification(notification: NotificationView) {
    setError("");
    if (!notification.readAt) {
      const response = await fetch(
        `/api/v1/notifications/${notification.id}/read`,
        { method: "PUT" },
      );
      if (!response.ok) {
        setError("The notification could not be marked as read.");
        return;
      }
      setItems((current) =>
        current.map((item) =>
          item.id === notification.id
            ? { ...item, readAt: new Date().toISOString() }
            : item,
        ),
      );
      setUnreadCount((current) => Math.max(0, current - 1));
    }
    router.push(
      `/projects/${notification.issue.projectKey}/boards/${notification.issue.boardId}?issue=${notification.issue.key}`,
    );
  }

  async function markAllRead() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/v1/notifications/read-all", {
        method: "PUT",
      });
      if (!response.ok) throw new Error();
      const now = new Date().toISOString();
      setItems((current) =>
        current.map((item) => ({ ...item, readAt: item.readAt ?? now })),
      );
      setUnreadCount(0);
      setNotice("All notifications marked as read.");
    } catch {
      setError("Notifications could not be marked as read.");
    } finally {
      setPending(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/notifications?limit=25&cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (!response.ok) throw new Error();
      const body = (await response.json()) as NotificationCenterView;
      setItems((current) => [...current, ...body.items]);
      setNextCursor(body.nextCursor);
      setUnreadCount(body.unreadCount);
    } catch {
      setError("More notifications could not be loaded.");
    } finally {
      setPending(false);
    }
  }

  async function savePreferences() {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/v1/notification-preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(preferences),
      });
      if (!response.ok) throw new Error();
      setPreferences((await response.json()) as NotificationPreferences);
      setNotice("Notification preferences saved.");
    } catch {
      setError("Notification preferences could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <Link className="brand" href="/projects">
          <span>V</span> Vibe JIRA
        </Link>
        <div className="user-actions">
          <SearchLink />
          <span>{displayName}</span>
          <LogoutButton />
        </div>
      </header>
      <div className="notifications-layout">
        <section aria-labelledby="notifications-title">
          <div className="notification-heading">
            <div>
              <p className="eyebrow">Inbox</p>
              <h1 id="notifications-title">Notifications</h1>
              <p className="muted" aria-live="polite">
                {unreadCount} unread
              </p>
            </div>
            <button
              className="secondary-button"
              disabled={pending || unreadCount === 0}
              onClick={() => void markAllRead()}
              type="button"
            >
              Mark all read
            </button>
          </div>
          {error && <p className="error-banner">{error}</p>}
          {notice && (
            <p className="success-banner" aria-live="polite">
              {notice}
            </p>
          )}
          <div className="notification-list">
            {items.length === 0 && (
              <p className="empty-state">You have no notifications yet.</p>
            )}
            {items.map((notification) => (
              <button
                className={`notification-card ${notification.readAt ? "" : "unread"}`}
                key={notification.id}
                onClick={() => void openNotification(notification)}
                type="button"
              >
                <span>
                  <strong>{message(notification)}</strong>
                  <small>
                    {notification.issue.key} · {notification.issue.summary}
                  </small>
                </span>
                <time dateTime={notification.createdAt}>
                  {new Date(notification.createdAt).toLocaleString()}
                </time>
              </button>
            ))}
          </div>
          {nextCursor && (
            <button
              className="secondary-button"
              disabled={pending}
              onClick={() => void loadMore()}
              type="button"
            >
              Load more
            </button>
          )}
        </section>
        <aside className="notification-preferences">
          <h2>Preferences</h2>
          <p className="muted">Choose which future events reach this inbox.</p>
          <label>
            <input
              checked={preferences.mentions}
              onChange={(event) =>
                setPreferences((current) => ({
                  ...current,
                  mentions: event.target.checked,
                }))
              }
              type="checkbox"
            />
            Mentions
          </label>
          <label>
            <input
              checked={preferences.issueComments}
              onChange={(event) =>
                setPreferences((current) => ({
                  ...current,
                  issueComments: event.target.checked,
                }))
              }
              type="checkbox"
            />
            Watched issue comments
          </label>
          <button
            className="primary-button"
            disabled={pending}
            onClick={() => void savePreferences()}
            type="button"
          >
            Save preferences
          </button>
        </aside>
      </div>
    </main>
  );
}
