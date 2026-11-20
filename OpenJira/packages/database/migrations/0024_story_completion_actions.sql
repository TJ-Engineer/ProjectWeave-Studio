CREATE TABLE completion_actions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  story_issue_id uuid NOT NULL REFERENCES issues(id),
  task_issue_id uuid NOT NULL REFERENCES issues(id),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 200),
  position integer NOT NULL CHECK (position >= 0 AND position < 50),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CHECK (story_issue_id <> task_issue_id),
  UNIQUE (task_issue_id)
);

CREATE INDEX completion_actions_story_lookup
  ON completion_actions (story_issue_id, position, id)
  WHERE removed_at IS NULL;

CREATE INDEX completion_actions_project_lookup
  ON completion_actions (project_id, story_issue_id)
  WHERE removed_at IS NULL;
