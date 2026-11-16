CREATE TABLE verification_cases (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    sequence integer NOT NULL CHECK (sequence > 0),
    key text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9_-]{1,63}$'),
    title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    method text NOT NULL CHECK (method IN ('analysis', 'inspection', 'demonstration', 'test')),
    procedure text NOT NULL CHECK (length(trim(procedure)) BETWEEN 1 AND 8000),
    acceptance_criteria text NOT NULL CHECK (length(trim(acceptance_criteria)) BETWEEN 1 AND 4000),
    owner_subject text NOT NULL,
    due_at timestamptz,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT verification_cases_review_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id)
        REFERENCES review_packages(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT verification_cases_owner_membership_fk
        FOREIGN KEY (organization_id, project_id, owner_subject)
        REFERENCES project_memberships(organization_id, project_id, subject)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, sequence),
    UNIQUE (organization_id, project_id, review_id, key),
    UNIQUE (organization_id, project_id, review_id, id),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE verification_case_targets (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    case_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    artifact_revision_id uuid NOT NULL,
    artifact_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT verification_case_targets_case_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id, case_id)
        REFERENCES verification_cases(organization_id, project_id, review_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT verification_case_targets_revision_tenant_fk
        FOREIGN KEY (organization_id, project_id, artifact_id, artifact_revision_id)
        REFERENCES artifact_revisions(organization_id, project_id, artifact_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, case_id, artifact_id)
);

CREATE TABLE verification_runs (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    case_id uuid NOT NULL,
    sequence integer NOT NULL CHECK (sequence > 0),
    status text NOT NULL CHECK (status IN ('in_progress', 'passed', 'failed', 'blocked')),
    executed_by text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT verification_runs_case_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id, case_id)
        REFERENCES verification_cases(organization_id, project_id, review_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, case_id, sequence),
    UNIQUE (organization_id, project_id, review_id, id),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE verification_run_events (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    run_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    event_type text NOT NULL CHECK (event_type IN ('started', 'completed')),
    status text NOT NULL CHECK (status IN ('in_progress', 'passed', 'failed', 'blocked')),
    note text NOT NULL DEFAULT '' CHECK (length(note) <= 8000),
    actor_subject text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT verification_run_events_run_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id, run_id)
        REFERENCES verification_runs(organization_id, project_id, review_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, run_id, version)
);

CREATE TABLE verification_results (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    run_id uuid NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('passed', 'failed', 'blocked')),
    notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 8000),
    measured_values jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(measured_values) = 'object'),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),
    signing_algorithm text NOT NULL,
    signing_key_id text NOT NULL,
    recorded_by text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT verification_results_run_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id, run_id)
        REFERENCES verification_runs(organization_id, project_id, review_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, run_id),
    UNIQUE (organization_id, project_id, review_id, id),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE verification_attachments (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    result_id uuid NOT NULL,
    object_key text NOT NULL CHECK (length(trim(object_key)) BETWEEN 1 AND 512),
    file_name text NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 255),
    media_type text NOT NULL CHECK (length(trim(media_type)) BETWEEN 1 AND 127),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT verification_attachments_result_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id, result_id)
        REFERENCES verification_results(organization_id, project_id, review_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, result_id, object_key)
);

CREATE TABLE verification_due_events (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    case_id uuid NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('due_soon', 'overdue', 'completed')),
    due_at timestamptz,
    actor_subject text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT verification_due_events_case_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id, case_id)
        REFERENCES verification_cases(organization_id, project_id, review_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, case_id, event_type)
);

CREATE TRIGGER verification_cases_append_only
    BEFORE UPDATE OR DELETE ON verification_cases
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER verification_case_targets_append_only
    BEFORE UPDATE OR DELETE ON verification_case_targets
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER verification_run_events_append_only
    BEFORE UPDATE OR DELETE ON verification_run_events
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER verification_results_append_only
    BEFORE UPDATE OR DELETE ON verification_results
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER verification_attachments_append_only
    BEFORE UPDATE OR DELETE ON verification_attachments
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER verification_due_events_append_only
    BEFORE UPDATE OR DELETE ON verification_due_events
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();

CREATE INDEX verification_cases_review_idx
    ON verification_cases (organization_id, project_id, review_id, sequence);
CREATE INDEX verification_case_targets_review_idx
    ON verification_case_targets (organization_id, project_id, review_id, artifact_id);
CREATE INDEX verification_runs_case_idx
    ON verification_runs (organization_id, project_id, case_id, sequence DESC);
CREATE INDEX verification_results_review_idx
    ON verification_results (organization_id, project_id, review_id, recorded_at);
CREATE INDEX verification_due_events_review_idx
    ON verification_due_events (organization_id, project_id, review_id, occurred_at DESC);

COMMENT ON TABLE verification_cases IS
    'Immutable verification intent and procedure bound to one approved review baseline.';
COMMENT ON TABLE verification_results IS
    'Append-only signed verification outcomes bound to an attributable execution.';
COMMENT ON TABLE verification_attachments IS
    'Append-only content-addressed attachment manifests for external object evidence.';
