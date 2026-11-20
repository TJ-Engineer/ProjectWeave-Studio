CREATE TABLE teams (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE team_members (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE project_team_members (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('ADMIN', 'MEMBER', 'VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, team_id)
);

CREATE VIEW effective_project_members AS
SELECT access.organization_id, access.project_id, access.user_id,
       CASE max(CASE access.role
         WHEN 'ADMIN' THEN 3 WHEN 'MEMBER' THEN 2 ELSE 1 END)
         WHEN 3 THEN 'ADMIN' WHEN 2 THEN 'MEMBER' ELSE 'VIEWER'
       END::text AS role
  FROM (
    SELECT organization_id, project_id, user_id, role
      FROM project_members
    UNION ALL
    SELECT assignment.organization_id, assignment.project_id,
           member.user_id, assignment.role
      FROM project_team_members assignment
      JOIN team_members member
        ON member.team_id = assignment.team_id
       AND member.organization_id = assignment.organization_id
  ) access
 GROUP BY access.organization_id, access.project_id, access.user_id;

CREATE INDEX team_members_user_lookup
  ON team_members (organization_id, user_id, team_id);

CREATE INDEX project_team_members_team_lookup
  ON project_team_members (organization_id, team_id, project_id);
