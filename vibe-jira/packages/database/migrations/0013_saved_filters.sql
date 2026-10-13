CREATE TABLE saved_filters (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid REFERENCES projects(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  visibility text NOT NULL CHECK (visibility IN ('PRIVATE', 'PROJECT', 'ORGANIZATION')),
  query_json jsonb NOT NULL,
  is_quick boolean NOT NULL DEFAULT false,
  position integer,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (visibility <> 'PROJECT' OR project_id IS NOT NULL),
  CHECK (NOT is_quick OR (visibility = 'PROJECT' AND project_id IS NOT NULL)),
  CHECK (position IS NULL OR position >= 0)
);

CREATE INDEX saved_filters_owner
  ON saved_filters (organization_id, owner_id, name, id);

CREATE INDEX saved_filters_shared
  ON saved_filters (organization_id, visibility, project_id, position, name, id);

CREATE UNIQUE INDEX saved_filters_quick_position
  ON saved_filters (project_id, position)
  WHERE is_quick;
