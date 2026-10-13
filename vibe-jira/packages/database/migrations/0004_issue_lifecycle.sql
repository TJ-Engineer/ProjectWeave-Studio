ALTER TABLE issues
  ADD COLUMN deleted_by uuid REFERENCES users(id);

ALTER TABLE issue_events
  DROP CONSTRAINT issue_events_event_type_check;

ALTER TABLE issue_events
  ADD CONSTRAINT issue_events_event_type_check
  CHECK (event_type IN ('CREATED', 'TRANSITIONED', 'UPDATED', 'DELETED', 'RESTORED'));

CREATE INDEX issues_deleted_lookup
  ON issues (project_id, deleted_at DESC, id)
  WHERE deleted_at IS NOT NULL;
