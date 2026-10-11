CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  organization_role text NOT NULL CHECK (organization_role IN ('ADMIN', 'MEMBER')),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_key text NOT NULL CHECK (project_key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name text NOT NULL,
  sequence_counter integer NOT NULL DEFAULT 0 CHECK (sequence_counter >= 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, project_key)
);

CREATE TABLE project_members (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('ADMIN', 'MEMBER', 'VIEWER')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE issue_types (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  hierarchy_level integer NOT NULL DEFAULT 0,
  UNIQUE (project_id, name)
);

CREATE TABLE workflows (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true
);

CREATE UNIQUE INDEX one_active_workflow_per_project
  ON workflows (project_id) WHERE active;

CREATE TABLE statuses (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('TODO', 'IN_PROGRESS', 'DONE')),
  color text NOT NULL,
  position integer NOT NULL,
  UNIQUE (workflow_id, name),
  UNIQUE (workflow_id, position)
);

CREATE TABLE transitions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  from_status_id uuid NOT NULL REFERENCES statuses(id),
  to_status_id uuid NOT NULL REFERENCES statuses(id),
  name text NOT NULL,
  UNIQUE (workflow_id, from_status_id, to_status_id)
);

CREATE TABLE boards (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  board_type text NOT NULL DEFAULT 'KANBAN' CHECK (board_type = 'KANBAN'),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE board_columns (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name text NOT NULL,
  position integer NOT NULL,
  wip_limit integer CHECK (wip_limit IS NULL OR wip_limit > 0),
  UNIQUE (board_id, position)
);

CREATE TABLE column_statuses (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  board_column_id uuid NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  status_id uuid NOT NULL REFERENCES statuses(id),
  PRIMARY KEY (board_column_id, status_id)
);

CREATE TABLE issues (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  number integer NOT NULL CHECK (number > 0),
  issue_type_id uuid NOT NULL REFERENCES issue_types(id),
  status_id uuid NOT NULL REFERENCES statuses(id),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 200),
  description text,
  priority text NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  reporter_id uuid NOT NULL REFERENCES users(id),
  assignee_id uuid REFERENCES users(id),
  parent_id uuid REFERENCES issues(id),
  rank numeric(30, 10) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (project_id, number),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX issues_board_lookup
  ON issues (project_id, status_id, rank) WHERE deleted_at IS NULL;

CREATE TABLE issue_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  issue_id uuid NOT NULL REFERENCES issues(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  event_type text NOT NULL CHECK (event_type IN ('CREATED', 'TRANSITIONED', 'UPDATED')),
  payload_json jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX issue_events_timeline ON issue_events (issue_id, created_at, id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  topic text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX unpublished_outbox_events
  ON outbox_events (created_at) WHERE published_at IS NULL;
