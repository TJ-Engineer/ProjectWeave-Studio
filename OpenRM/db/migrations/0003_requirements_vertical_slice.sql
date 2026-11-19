CREATE TABLE artifact_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    key text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9_]{1,31}$'),
    name text NOT NULL CHECK (length(trim(name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT artifact_types_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE CASCADE,
    UNIQUE (organization_id, project_id, key),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE artifacts (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    artifact_type_id uuid NOT NULL,
    key text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9-]{1,31}$'),
    title text NOT NULL CHECK (length(trim(title)) > 0),
    statement text NOT NULL CHECK (length(trim(statement)) > 0),
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
    current_revision_id uuid NOT NULL,
    current_revision_number integer NOT NULL CHECK (current_revision_number > 0),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT artifacts_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT artifacts_type_tenant_fk
        FOREIGN KEY (organization_id, project_id, artifact_type_id)
        REFERENCES artifact_types(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, key),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE artifact_revisions (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision_number integer NOT NULL CHECK (revision_number > 0),
    title text NOT NULL CHECK (length(trim(title)) > 0),
    statement text NOT NULL CHECK (length(trim(statement)) > 0),
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT artifact_revisions_artifact_tenant_fk
        FOREIGN KEY (organization_id, project_id, artifact_id)
        REFERENCES artifacts(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, artifact_id, revision_number),
    UNIQUE (organization_id, project_id, artifact_id, id)
);

ALTER TABLE artifacts
    ADD CONSTRAINT artifacts_current_revision_fk
    FOREIGN KEY (organization_id, project_id, id, current_revision_id)
    REFERENCES artifact_revisions(organization_id, project_id, artifact_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE command_results (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_subject text NOT NULL,
    command_name text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    response_revision integer NOT NULL CHECK (response_revision > 0),
    response_payload jsonb NOT NULL CHECK (jsonb_typeof(response_payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, actor_subject, command_name, idempotency_key)
);

CREATE INDEX artifacts_project_updated_idx
    ON artifacts (organization_id, project_id, updated_at DESC);
CREATE INDEX artifacts_project_search_idx
    ON artifacts USING gin (
        to_tsvector('english', key || ' ' || title || ' ' || statement)
    );
CREATE INDEX artifact_revisions_history_idx
    ON artifact_revisions (organization_id, project_id, artifact_id, revision_number DESC);

INSERT INTO artifact_types (organization_id, project_id, key, name)
SELECT organization_id, id, 'REQUIREMENT', 'Requirement'
FROM projects
ON CONFLICT (organization_id, project_id, key) DO NOTHING;

COMMENT ON TABLE artifacts IS
    'Materialized current state for controlled project artifacts.';
COMMENT ON TABLE artifact_revisions IS
    'Immutable artifact revision history; rows are never updated or deleted by application workflows.';
COMMENT ON TABLE command_results IS
    'Idempotency evidence for controlled commands, scoped to tenant, actor, command, and client key.';
