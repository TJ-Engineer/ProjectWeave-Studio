CREATE TABLE labels (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  normalized_name text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, normalized_name),
  CHECK (length(normalized_name) BETWEEN 1 AND 50),
  CHECK (length(display_name) BETWEEN 1 AND 50)
);

CREATE TABLE issue_labels (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);

CREATE INDEX issue_labels_label_lookup
  ON issue_labels (label_id, issue_id);

CREATE INDEX issues_parent_lookup
  ON issues (parent_id, number)
  WHERE deleted_at IS NULL;
