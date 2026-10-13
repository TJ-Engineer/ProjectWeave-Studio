ALTER TABLE organizations
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE users
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE projects
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE boards
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE INDEX projects_organization_archive_name
  ON projects (organization_id, archived_at, name, id);
