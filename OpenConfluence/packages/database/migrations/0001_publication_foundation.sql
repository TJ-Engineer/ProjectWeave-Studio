CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'DEACTIVATED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email),
  UNIQUE (organization_id, id)
);

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  organization_role text NOT NULL CHECK (organization_role IN ('ADMIN', 'MEMBER')),
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id)
);

CREATE TABLE spaces (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  space_key text NOT NULL CHECK (space_key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, space_key),
  UNIQUE (organization_id, id)
);

CREATE TABLE space_grants (
  organization_id uuid NOT NULL,
  space_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN', 'EDITOR', 'VIEWER')),
  PRIMARY KEY (space_id, user_id),
  FOREIGN KEY (organization_id, space_id) REFERENCES spaces(organization_id, id),
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id)
);

CREATE TABLE pages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  space_id uuid NOT NULL,
  parent_id uuid,
  current_revision_id uuid,
  title text NOT NULL,
  slug text NOT NULL,
  sibling_rank numeric(30, 15) NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'ARCHIVED', 'TRASHED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (space_id, slug),
  FOREIGN KEY (organization_id, space_id) REFERENCES spaces(organization_id, id),
  FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, parent_id) REFERENCES pages(organization_id, id)
);

CREATE TABLE page_revisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  page_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  author_id uuid NOT NULL,
  title text NOT NULL,
  body_json jsonb NOT NULL,
  body_text text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  summary text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (page_id, number),
  UNIQUE (page_id, author_id, idempotency_key),
  FOREIGN KEY (organization_id, page_id) REFERENCES pages(organization_id, id),
  FOREIGN KEY (organization_id, author_id) REFERENCES users(organization_id, id)
);

ALTER TABLE pages
  ADD CONSTRAINT pages_current_revision_same_tenant
  FOREIGN KEY (organization_id, current_revision_id)
  REFERENCES page_revisions(organization_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE drafts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  page_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  base_revision_id uuid,
  title text NOT NULL,
  body_json jsonb NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  saved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, owner_id),
  FOREIGN KEY (organization_id, page_id) REFERENCES pages(organization_id, id),
  FOREIGN KEY (organization_id, owner_id) REFERENCES users(organization_id, id),
  FOREIGN KEY (organization_id, base_revision_id) REFERENCES page_revisions(organization_id, id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, actor_id) REFERENCES users(organization_id, id)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  topic text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pages_tree_idx ON pages (organization_id, space_id, parent_id, sibling_rank)
  WHERE state = 'ACTIVE';
CREATE INDEX revisions_page_idx ON page_revisions (organization_id, page_id, number DESC);
CREATE INDEX outbox_pending_idx ON outbox_events (created_at)
  WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION prevent_revision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published revisions are append-only';
END;
$$;

CREATE TRIGGER page_revisions_no_update
BEFORE UPDATE OR DELETE ON page_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_revision_mutation();
