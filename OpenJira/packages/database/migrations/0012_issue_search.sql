ALTER TABLE issues
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX issues_search_vector_gin
  ON issues USING gin (search_vector)
  WHERE deleted_at IS NULL;

CREATE INDEX issues_search_created
  ON issues (organization_id, created_at DESC, project_id, number, id)
  WHERE deleted_at IS NULL;

CREATE INDEX issues_search_updated
  ON issues (organization_id, updated_at DESC, project_id, number, id)
  WHERE deleted_at IS NULL;

CREATE INDEX issues_search_reporter
  ON issues (organization_id, reporter_id, updated_at DESC)
  WHERE deleted_at IS NULL;
