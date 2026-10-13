ALTER TABLE issues
  ADD COLUMN estimate_points integer CHECK (
    estimate_points IS NULL OR estimate_points BETWEEN 0 AND 1000000
  ),
  ADD COLUMN due_date date;

CREATE INDEX issues_project_due_date
  ON issues (project_id, due_date, id)
  WHERE deleted_at IS NULL AND due_date IS NOT NULL;
