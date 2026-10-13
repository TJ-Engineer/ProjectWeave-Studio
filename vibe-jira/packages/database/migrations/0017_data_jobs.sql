CREATE TABLE data_jobs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  job_type text NOT NULL CHECK (job_type IN ('CSV_IMPORT', 'CSV_EXPORT')),
  state text NOT NULL DEFAULT 'QUEUED'
    CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  input_text text,
  input_options jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_text text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (organization_id, actor_id, job_type, idempotency_key)
);

CREATE INDEX data_jobs_claim
  ON data_jobs (created_at, id) WHERE state = 'QUEUED';

CREATE INDEX data_jobs_project_timeline
  ON data_jobs (organization_id, project_id, created_at DESC, id DESC);
