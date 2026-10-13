UPDATE issue_events e
   SET payload_json = e.payload_json || jsonb_build_object(
         'initialStatusCategory', s.category
       )
  FROM statuses s
 WHERE e.event_type = 'CREATED'
   AND e.payload_json ? 'statusId'
   AND s.id = (e.payload_json ->> 'statusId')::uuid
   AND NOT (e.payload_json ? 'initialStatusCategory');

UPDATE issue_events e
   SET payload_json = e.payload_json || jsonb_build_object(
         'fromStatusCategory', source.category,
         'toStatusCategory', destination.category
       )
  FROM statuses source, statuses destination
 WHERE e.event_type = 'TRANSITIONED'
   AND e.payload_json ? 'fromStatusId'
   AND e.payload_json ? 'toStatusId'
   AND source.id = (e.payload_json ->> 'fromStatusId')::uuid
   AND destination.id = (e.payload_json ->> 'toStatusId')::uuid
   AND NOT (e.payload_json ? 'fromStatusCategory');

CREATE INDEX issue_events_organization_created
  ON issue_events (organization_id, created_at, issue_id);
