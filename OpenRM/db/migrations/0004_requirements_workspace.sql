ALTER TABLE projects
    ADD COLUMN description text NOT NULL DEFAULT '';

CREATE TABLE project_memberships (
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    subject text NOT NULL,
    role text NOT NULL CHECK (role IN ('administrator', 'author', 'reviewer', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_memberships_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE CASCADE,
    PRIMARY KEY (organization_id, project_id, subject)
);

CREATE TABLE folders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    parent_id uuid,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT folders_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT folders_parent_tenant_fk
        FOREIGN KEY (organization_id, project_id, parent_id)
        REFERENCES folders(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE NULLS NOT DISTINCT (organization_id, project_id, parent_id, name),
    UNIQUE (organization_id, project_id, id)
);

ALTER TABLE artifacts
    ADD COLUMN folder_id uuid,
    ADD CONSTRAINT artifacts_folder_tenant_fk
        FOREIGN KEY (organization_id, project_id, folder_id)
        REFERENCES folders(organization_id, project_id, id)
        ON DELETE SET NULL;

ALTER TABLE artifact_revisions
    ADD COLUMN folder_id uuid,
    ADD COLUMN tag_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    ADD CONSTRAINT artifact_revisions_folder_tenant_fk
        FOREIGN KEY (organization_id, project_id, folder_id)
        REFERENCES folders(organization_id, project_id, id)
        ON DELETE RESTRICT;

CREATE TABLE tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 64),
    color text NOT NULL DEFAULT '#64748b' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tags_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE CASCADE,
    UNIQUE (organization_id, project_id, name),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE artifact_tags (
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    CONSTRAINT artifact_tags_artifact_tenant_fk
        FOREIGN KEY (organization_id, project_id, artifact_id)
        REFERENCES artifacts(organization_id, project_id, id)
        ON DELETE CASCADE,
    CONSTRAINT artifact_tags_tag_tenant_fk
        FOREIGN KEY (organization_id, project_id, tag_id)
        REFERENCES tags(organization_id, project_id, id)
        ON DELETE CASCADE,
    PRIMARY KEY (organization_id, project_id, artifact_id, tag_id)
);

CREATE TABLE custom_attribute_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
    label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
    value_type text NOT NULL CHECK (value_type IN ('text', 'number', 'boolean', 'enum')),
    required boolean NOT NULL DEFAULT false,
    config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT custom_attributes_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE CASCADE,
    UNIQUE (organization_id, project_id, key),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE saved_views (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    owner_subject text NOT NULL,
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT saved_views_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE CASCADE,
    UNIQUE (organization_id, project_id, owner_subject, name)
);

CREATE OR REPLACE FUNCTION prevent_controlled_history_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER artifact_revisions_append_only
    BEFORE UPDATE OR DELETE ON artifact_revisions
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();

CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();

INSERT INTO folders (organization_id, project_id, name, created_by)
SELECT organization_id, id, 'Requirements', 'system:migration'
FROM projects
ON CONFLICT (organization_id, project_id, parent_id, name) DO NOTHING;

INSERT INTO custom_attribute_definitions (
    organization_id, project_id, key, label, value_type, required, config, created_by
)
SELECT organization_id, id, 'priority', 'Priority', 'enum', false,
       '{"options":["low","medium","high","critical"]}'::jsonb,
       'system:migration'
FROM projects
ON CONFLICT (organization_id, project_id, key) DO NOTHING;

CREATE INDEX project_memberships_subject_idx
    ON project_memberships (organization_id, subject, project_id);
CREATE INDEX folders_project_parent_idx
    ON folders (organization_id, project_id, parent_id, name);
CREATE INDEX tags_project_name_idx
    ON tags (organization_id, project_id, name);
CREATE INDEX artifact_tags_tag_idx
    ON artifact_tags (organization_id, project_id, tag_id, artifact_id);
CREATE INDEX saved_views_owner_idx
    ON saved_views (organization_id, project_id, owner_subject, name);

COMMENT ON TABLE project_memberships IS
    'Project-scoped roles evaluated after the organization tenant boundary.';
COMMENT ON TRIGGER artifact_revisions_append_only ON artifact_revisions IS
    'Database enforcement for immutable controlled revision evidence.';
COMMENT ON TRIGGER audit_events_append_only ON audit_events IS
    'Database enforcement for immutable mutation audit evidence.';
