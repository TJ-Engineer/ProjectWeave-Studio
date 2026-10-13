CREATE TABLE notification_preferences (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_class text NOT NULL CHECK (event_class IN ('MENTION', 'ISSUE_COMMENTED')),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_class)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_outbox_id uuid NOT NULL REFERENCES outbox_events(id),
  event_class text NOT NULL CHECK (event_class IN ('MENTION', 'ISSUE_COMMENTED')),
  issue_id uuid NOT NULL REFERENCES issues(id),
  comment_id uuid NOT NULL REFERENCES comments(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_outbox_id)
);

CREATE INDEX notifications_recipient_timeline
  ON notifications (recipient_user_id, created_at DESC, id DESC);

CREATE INDEX notifications_recipient_unread
  ON notifications (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

ALTER TABLE outbox_events
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_error text,
  ADD COLUMN dead_lettered_at timestamptz;

CREATE INDEX notification_outbox_claim
  ON outbox_events (available_at, created_at, id)
  WHERE published_at IS NULL
    AND dead_lettered_at IS NULL
    AND topic IN ('notification.mention', 'notification.issue_commented');
