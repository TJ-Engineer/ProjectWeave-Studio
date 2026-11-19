CREATE TABLE agent_runs (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    external_run_id text NOT NULL CHECK (length(trim(external_run_id)) BETWEEN 1 AND 200),
    model text NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 200),
    prompt text NOT NULL CHECK (length(trim(prompt)) BETWEEN 1 AND 100000),
    context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
    tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_calls) = 'array'),
    output jsonb NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
    started_at timestamptz NOT NULL,
    completed_at timestamptz NOT NULL,
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),
    signing_algorithm text NOT NULL,
    signing_key_id text NOT NULL,
    recorded_by text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_runs_time_order CHECK (completed_at >= started_at),
    CONSTRAINT agent_runs_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, external_run_id),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE agent_run_outputs (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    agent_run_id uuid NOT NULL,
    relation text NOT NULL CHECK (relation IN ('created', 'updated', 'generated', 'referenced', 'verified')),
    artifact_id uuid,
    artifact_revision_id uuid,
    external_system text,
    external_reference text,
    external_uri text,
    sha256 text,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_run_outputs_run_tenant_fk
        FOREIGN KEY (organization_id, project_id, agent_run_id)
        REFERENCES agent_runs(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT agent_run_outputs_artifact_revision_tenant_fk
        FOREIGN KEY (organization_id, project_id, artifact_id, artifact_revision_id)
        REFERENCES artifact_revisions(organization_id, project_id, artifact_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT agent_run_outputs_reference_shape CHECK (
        (
            artifact_id IS NOT NULL
            AND artifact_revision_id IS NOT NULL
            AND external_system IS NULL
            AND external_reference IS NULL
            AND external_uri IS NULL
            AND sha256 IS NULL
        )
        OR
        (
            artifact_id IS NULL
            AND artifact_revision_id IS NULL
            AND length(trim(external_system)) BETWEEN 1 AND 80
            AND length(trim(external_reference)) BETWEEN 1 AND 500
            AND (external_uri IS NULL OR length(trim(external_uri)) BETWEEN 1 AND 2000)
            AND (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$')
        )
    ),
    UNIQUE (organization_id, project_id, agent_run_id, id)
);

CREATE UNIQUE INDEX agent_run_outputs_internal_unique
    ON agent_run_outputs (
        organization_id, project_id, agent_run_id,
        relation, artifact_id, artifact_revision_id
    )
    WHERE artifact_id IS NOT NULL;

CREATE UNIQUE INDEX agent_run_outputs_external_unique
    ON agent_run_outputs (
        organization_id, project_id, agent_run_id,
        relation, external_system, external_reference
    )
    WHERE external_system IS NOT NULL;

CREATE INDEX agent_runs_project_recorded_idx
    ON agent_runs (organization_id, project_id, recorded_at DESC, id DESC);

CREATE INDEX agent_run_outputs_artifact_idx
    ON agent_run_outputs (
        organization_id, project_id, artifact_id, artifact_revision_id
    )
    WHERE artifact_id IS NOT NULL;

CREATE TRIGGER agent_runs_append_only
    BEFORE UPDATE OR DELETE ON agent_runs
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();

CREATE TRIGGER agent_run_outputs_append_only
    BEFORE UPDATE OR DELETE ON agent_run_outputs
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();

COMMENT ON TABLE agent_runs IS
    'Immutable signed configuration-management evidence for attributable agent executions.';

COMMENT ON TABLE agent_run_outputs IS
    'Append-only exact OpenRM revision or external-system output links produced by an agent execution.';
