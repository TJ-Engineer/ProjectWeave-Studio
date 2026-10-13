ALTER TABLE issue_events
  DROP CONSTRAINT issue_events_event_type_check;

ALTER TABLE issue_events
  ADD CONSTRAINT issue_events_event_type_check
  CHECK (event_type IN ('CREATED', 'TRANSITIONED', 'REORDERED', 'UPDATED', 'DELETED', 'RESTORED'));
