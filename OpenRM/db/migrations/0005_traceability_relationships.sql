CREATE TABLE relationship_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    key text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9_]{1,31}$'),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    source_artifact_type_id uuid NOT NULL,
    target_artifact_type_id uuid NOT NULL,
    max_targets_per_source integer CHECK (max_targets_per_source IS NULL OR max_targets_per_source > 0),
    max_sources_per_target integer CHECK (max_sources_per_target IS NULL OR max_sources_per_target > 0),
    propagates_suspect boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT relationship_types_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT relationship_types_source_type_tenant_fk
        FOREIGN KEY (organization_id, project_id, source_artifact_type_id)
        REFERENCES artifact_types(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT relationship_types_target_type_tenant_fk
        FOREIGN KEY (organization_id, project_id, target_artifact_type_id)
        REFERENCES artifact_types(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, key),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE relationships (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    relationship_type_id uuid NOT NULL,
    source_artifact_id uuid NOT NULL,
    target_artifact_id uuid NOT NULL,
    current_revision_id uuid NOT NULL,
    current_version integer NOT NULL CHECK (current_version > 0),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT relationships_distinct_endpoints CHECK (source_artifact_id <> target_artifact_id),
    CONSTRAINT relationships_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT relationships_type_tenant_fk
        FOREIGN KEY (organization_id, project_id, relationship_type_id)
        REFERENCES relationship_types(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT relationships_source_tenant_fk
        FOREIGN KEY (organization_id, project_id, source_artifact_id)
        REFERENCES artifacts(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT relationships_target_tenant_fk
        FOREIGN KEY (organization_id, project_id, target_artifact_id)
        REFERENCES artifacts(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, id),
    UNIQUE (organization_id, project_id, relationship_type_id, source_artifact_id, target_artifact_id)
);

CREATE TABLE relationship_revisions (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    relationship_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    relationship_type_id uuid NOT NULL,
    source_artifact_id uuid NOT NULL,
    source_revision_id uuid NOT NULL,
    target_artifact_id uuid NOT NULL,
    target_revision_id uuid NOT NULL,
    suspect boolean NOT NULL DEFAULT false,
    suspect_reason text,
    disposition text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT relationship_revisions_relationship_tenant_fk
        FOREIGN KEY (organization_id, project_id, relationship_id)
        REFERENCES relationships(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT relationship_revisions_type_tenant_fk
        FOREIGN KEY (organization_id, project_id, relationship_type_id)
        REFERENCES relationship_types(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT relationship_revisions_source_revision_tenant_fk
        FOREIGN KEY (organization_id, project_id, source_artifact_id, source_revision_id)
        REFERENCES artifact_revisions(organization_id, project_id, artifact_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT relationship_revisions_target_revision_tenant_fk
        FOREIGN KEY (organization_id, project_id, target_artifact_id, target_revision_id)
        REFERENCES artifact_revisions(organization_id, project_id, artifact_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, relationship_id, version),
    UNIQUE (organization_id, project_id, relationship_id, id)
);

ALTER TABLE relationships
    ADD CONSTRAINT relationships_current_revision_fk
    FOREIGN KEY (organization_id, project_id, id, current_revision_id)
    REFERENCES relationship_revisions(organization_id, project_id, relationship_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER relationship_revisions_append_only
    BEFORE UPDATE OR DELETE ON relationship_revisions
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();

INSERT INTO relationship_types (
    organization_id, project_id, key, name,
    source_artifact_type_id, target_artifact_type_id,
    max_targets_per_source, max_sources_per_target, propagates_suspect
)
SELECT t.organization_id, t.project_id, defaults.key, defaults.name,
       t.id, t.id, defaults.max_targets, defaults.max_sources, true
FROM artifact_types t
CROSS JOIN (
    VALUES
        ('DECOMPOSES_TO', 'Decomposes to', NULL::integer, 1),
        ('DEPENDS_ON', 'Depends on', NULL::integer, NULL::integer)
) AS defaults(key, name, max_targets, max_sources)
WHERE t.key = 'REQUIREMENT'
ON CONFLICT (organization_id, project_id, key) DO NOTHING;

CREATE INDEX relationship_types_project_key_idx
    ON relationship_types (organization_id, project_id, key);
CREATE INDEX relationships_source_idx
    ON relationships (organization_id, project_id, source_artifact_id, relationship_type_id);
CREATE INDEX relationships_target_idx
    ON relationships (organization_id, project_id, target_artifact_id, relationship_type_id);
CREATE INDEX relationship_revisions_history_idx
    ON relationship_revisions (organization_id, project_id, relationship_id, version DESC);

COMMENT ON TABLE relationship_types IS
    'Project-configurable directed relationship rules, including endpoint types and optional cardinality limits.';
COMMENT ON TABLE relationships IS
    'Materialized current state for directed, typed traceability relationships.';
COMMENT ON TABLE relationship_revisions IS
    'Append-only relationship evidence bound to exact source and target artifact revisions.';
COMMENT ON TRIGGER relationship_revisions_append_only ON relationship_revisions IS
    'Database enforcement for immutable relationship revision evidence.';
