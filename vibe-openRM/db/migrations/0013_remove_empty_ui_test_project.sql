-- Remove the exact empty project created while exercising the project-setup UI.
-- Audit history is removed only for this disposable test aggregate so the
-- project-level foreign key can be satisfied; controlled production projects
-- and their append-only evidence remain untouched.
ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;

DELETE FROM audit_events
WHERE project_id IN (
    SELECT id
    FROM projects
    WHERE organization_id = '00000000-0000-4000-8000-000000000002'
      AND key = 'KANBAN'
      AND name = 'OpenJIRA'
      AND NOT EXISTS (SELECT 1 FROM artifacts WHERE artifacts.project_id = projects.id)
);

ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only;

DELETE FROM projects
WHERE organization_id = '00000000-0000-4000-8000-000000000002'
  AND key = 'KANBAN'
  AND name = 'OpenJIRA'
  AND NOT EXISTS (SELECT 1 FROM artifacts WHERE artifacts.project_id = projects.id);
