"use client";

import type { NotificationCenterView } from "@vibe/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";

export function NotificationLink() {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/notifications?limit=1")
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as NotificationCenterView;
      })
      .then((body) => {
        if (active && body) setUnread(body.unreadCount);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return (
    <Link className="notification-link" href="/notifications">
      Notifications
      {unread > 0 && (
        <span className="notification-badge" aria-label={`${unread} unread`}>
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
