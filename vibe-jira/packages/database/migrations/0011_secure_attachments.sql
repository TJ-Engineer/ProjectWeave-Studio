CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  issue_id uuid NOT NULL REFERENCES issues(id),
  uploader_id uuid NOT NULL REFERENCES users(id),
  object_key text NOT NULL UNIQUE,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  scan_state text NOT NULL CHECK (scan_state IN ('PENDING', 'CLEAN', 'REJECTED', 'ERROR')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id)
);

CREATE INDEX attachments_issue_active
  ON attachments (issue_id, created_at, id)
  WHERE deleted_at IS NULL;

ALTER TABLE issue_events
  DROP CONSTRAINT issue_events_event_type_check;

ALTER TABLE issue_events
  ADD CONSTRAINT issue_events_event_type_check
  CHECK (event_type IN (
    'CREATED', 'TRANSITIONED', 'REORDERED', 'UPDATED', 'DELETED',
    'RESTORED', 'COMMENTED', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED'
  ));
