CREATE OR REPLACE FUNCTION notify_issue_board_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_project_id uuid;
  changed_issue_id uuid;
  changed_version integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_project_id := OLD.project_id;
    changed_issue_id := OLD.id;
    changed_version := OLD.version;
  ELSE
    changed_project_id := NEW.project_id;
    changed_issue_id := NEW.id;
    changed_version := NEW.version;
  END IF;
  PERFORM pg_notify(
    'vibe_board_changes',
    json_build_object(
      'projectId', changed_project_id,
      'entity', 'issue',
      'entityId', changed_issue_id,
      'version', changed_version,
      'operation', TG_OP
    )::text
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER issues_board_change_notification
AFTER INSERT OR UPDATE OR DELETE ON issues
FOR EACH ROW EXECUTE FUNCTION notify_issue_board_change();

CREATE OR REPLACE FUNCTION notify_board_column_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_project_id uuid;
  changed_column_id uuid;
  changed_version integer;
  changed_board_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_board_id := OLD.board_id;
    changed_column_id := OLD.id;
    changed_version := OLD.version;
  ELSE
    changed_board_id := NEW.board_id;
    changed_column_id := NEW.id;
    changed_version := NEW.version;
  END IF;
  SELECT project_id INTO changed_project_id
    FROM boards
   WHERE id = changed_board_id;
  PERFORM pg_notify(
    'vibe_board_changes',
    json_build_object(
      'projectId', changed_project_id,
      'entity', 'board_column',
      'entityId', changed_column_id,
      'version', changed_version,
      'operation', TG_OP
    )::text
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER board_columns_change_notification
AFTER INSERT OR UPDATE OR DELETE ON board_columns
FOR EACH ROW EXECUTE FUNCTION notify_board_column_change();
