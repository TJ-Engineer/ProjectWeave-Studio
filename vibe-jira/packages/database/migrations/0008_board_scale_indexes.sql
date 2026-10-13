CREATE INDEX issues_board_cursor
  ON issues (project_id, status_id, rank, id)
  WHERE deleted_at IS NULL;

CREATE INDEX issues_board_assignee_filter
  ON issues (project_id, assignee_id, status_id, rank, id)
  WHERE deleted_at IS NULL;

CREATE INDEX issues_board_priority_filter
  ON issues (project_id, priority, status_id, rank, id)
  WHERE deleted_at IS NULL;
