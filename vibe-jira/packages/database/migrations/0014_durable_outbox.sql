CREATE TABLE outbox_deliveries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  source_outbox_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  consumer text NOT NULL CHECK (consumer ~ '^[a-z][a-z0-9_-]{1,63}$'),
  delivered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_outbox_id, consumer)
);

CREATE INDEX outbox_deliveries_organization_timeline
  ON outbox_deliveries (organization_id, delivered_at DESC, id DESC);

CREATE TABLE worker_heartbeats (
  worker_name text PRIMARY KEY CHECK (worker_name ~ '^[a-z][a-z0-9_-]{1,63}$'),
  instance_id text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);

CREATE INDEX general_outbox_claim
  ON outbox_events (available_at, created_at, id)
  WHERE published_at IS NULL
    AND dead_lettered_at IS NULL
    AND topic NOT IN ('notification.mention', 'notification.issue_commented');
