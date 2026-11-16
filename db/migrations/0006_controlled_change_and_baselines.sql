CREATE TABLE changesets (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    sequence integer NOT NULL CHECK (sequence > 0),
    message text NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
    parent_changeset_id uuid,
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT changesets_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT changesets_parent_tenant_fk
        FOREIGN KEY (organization_id, project_id, parent_changeset_id)
        REFERENCES changesets(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, sequence),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE changeset_entries (
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    changeset_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    artifact_revision_id uuid NOT NULL,
    artifact_key text NOT NULL,
    revision_number integer NOT NULL CHECK (revision_number > 0),
    change_type text NOT NULL CHECK (change_type IN ('added', 'modified', 'unchanged')),
    CONSTRAINT changeset_entries_changeset_tenant_fk
        FOREIGN KEY (organization_id, project_id, changeset_id)
        REFERENCES changesets(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT changeset_entries_artifact_revision_tenant_fk
        FOREIGN KEY (organization_id, project_id, artifact_id, artifact_revision_id)
        REFERENCES artifact_revisions(organization_id, project_id, artifact_id, id)
        ON DELETE RESTRICT,
    PRIMARY KEY (organization_id, project_id, changeset_id, artifact_id)
);

CREATE TABLE baselines (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    sequence integer NOT NULL CHECK (sequence > 0),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
    changeset_id uuid,
    supersedes_baseline_id uuid,
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),
    signing_algorithm text NOT NULL,
    signing_key_id text NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT baselines_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT baselines_changeset_tenant_fk
        FOREIGN KEY (organization_id, project_id, changeset_id)
        REFERENCES changesets(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT baselines_supersedes_tenant_fk
        FOREIGN KEY (organization_id, project_id, supersedes_baseline_id)
        REFERENCES baselines(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, sequence),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE baseline_artifacts (
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    baseline_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    artifact_revision_id uuid NOT NULL,
    artifact_key text NOT NULL,
    revision_number integer NOT NULL CHECK (revision_number > 0),
    CONSTRAINT baseline_artifacts_baseline_tenant_fk
        FOREIGN KEY (organization_id, project_id, baseline_id)
        REFERENCES baselines(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT baseline_artifacts_revision_tenant_fk
        FOREIGN KEY (organization_id, project_id, artifact_id, artifact_revision_id)
        REFERENCES artifact_revisions(organization_id, project_id, artifact_id, id)
        ON DELETE RESTRICT,
    PRIMARY KEY (organization_id, project_id, baseline_id, artifact_id)
);

CREATE TABLE baseline_relationships (
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    baseline_id uuid NOT NULL,
    relationship_id uuid NOT NULL,
    relationship_revision_id uuid NOT NULL,
    relationship_type_key text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    source_artifact_id uuid NOT NULL,
    source_revision_id uuid NOT NULL,
    target_artifact_id uuid NOT NULL,
    target_revision_id uuid NOT NULL,
    suspect boolean NOT NULL,
    CONSTRAINT baseline_relationships_baseline_tenant_fk
        FOREIGN KEY (organization_id, project_id, baseline_id)
        REFERENCES baselines(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT baseline_relationships_revision_tenant_fk
        FOREIGN KEY (organization_id, project_id, relationship_id, relationship_revision_id)
        REFERENCES relationship_revisions(organization_id, project_id, relationship_id, id)
        ON DELETE RESTRICT,
    PRIMARY KEY (organization_id, project_id, baseline_id, relationship_id)
);

CREATE TRIGGER changesets_append_only
    BEFORE UPDATE OR DELETE ON changesets
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER changeset_entries_append_only
    BEFORE UPDATE OR DELETE ON changeset_entries
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER baselines_append_only
    BEFORE UPDATE OR DELETE ON baselines
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER baseline_artifacts_append_only
    BEFORE UPDATE OR DELETE ON baseline_artifacts
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER baseline_relationships_append_only
    BEFORE UPDATE OR DELETE ON baseline_relationships
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();

CREATE INDEX changesets_project_sequence_idx
    ON changesets (organization_id, project_id, sequence DESC);
CREATE INDEX baselines_project_sequence_idx
    ON baselines (organization_id, project_id, sequence DESC);

COMMENT ON TABLE changesets IS
    'Immutable attributable snapshots of current artifact revisions with parent-relative diff classifications.';
COMMENT ON TABLE baselines IS
    'Immutable signed manifests of artifact revisions, relationship revisions, and policy version evidence.';
