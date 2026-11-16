CREATE TABLE connector_configurations (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    connector_type text NOT NULL CHECK (connector_type IN ('jira')),
    mode text NOT NULL CHECK (mode IN ('disabled', 'dry_run', 'active')),
    base_url text NOT NULL CHECK (base_url ~ '^https?://[^[:space:]]+$'),
    remote_project_key text NOT NULL CHECK (remote_project_key ~ '^[A-Z][A-Z0-9_-]{1,31}$'),
    secret_ref text NOT NULL CHECK (length(trim(secret_ref)) BETWEEN 1 AND 200),
    field_mapping jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_mapping) = 'object'),
    max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT connector_configurations_project_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, connector_type),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE connector_configuration_events (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    connector_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    mode text NOT NULL CHECK (mode IN ('disabled', 'dry_run', 'active')),
    base_url text NOT NULL,
    remote_project_key text NOT NULL,
    secret_ref text NOT NULL,
    field_mapping jsonb NOT NULL CHECK (jsonb_typeof(field_mapping) = 'object'),
    max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
    actor_subject text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT connector_configuration_events_config_fk
        FOREIGN KEY (organization_id, project_id, connector_id)
        REFERENCES connector_configurations(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, connector_id, version)
);

CREATE TABLE connector_deliveries (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    connector_id uuid NOT NULL,
    event_key text NOT NULL CHECK (length(trim(event_key)) BETWEEN 8 AND 128),
    operation text NOT NULL CHECK (operation IN ('link_issue', 'comment_revision', 'sync_status')),
    external_issue_key text NOT NULL CHECK (external_issue_key ~ '^[A-Z][A-Z0-9_-]{1,31}-[1-9][0-9]*$'),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('pending', 'processing', 'retry', 'delivered', 'dead_letter')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    delivered_at timestamptz,
    last_error text,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT connector_deliveries_config_fk
        FOREIGN KEY (organization_id, project_id, connector_id)
        REFERENCES connector_configurations(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, connector_id, event_key),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE connector_delivery_attempts (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    attempt integer NOT NULL CHECK (attempt > 0),
    outcome text NOT NULL CHECK (outcome IN ('delivered', 'retry', 'dead_letter')),
    response_status integer CHECK (response_status BETWEEN 100 AND 599),
    retry_after_seconds integer CHECK (retry_after_seconds BETWEEN 1 AND 3600),
    error text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT connector_delivery_attempts_delivery_fk
        FOREIGN KEY (organization_id, project_id, delivery_id)
        REFERENCES connector_deliveries(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, delivery_id, attempt)
);

CREATE TRIGGER connector_configuration_events_append_only
    BEFORE UPDATE OR DELETE ON connector_configuration_events
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER connector_delivery_attempts_append_only
    BEFORE UPDATE OR DELETE ON connector_delivery_attempts
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();

CREATE INDEX connector_deliveries_pending_idx
    ON connector_deliveries (available_at, created_at)
    WHERE status IN ('pending', 'retry', 'processing');
CREATE INDEX connector_deliveries_project_idx
    ON connector_deliveries (organization_id, project_id, created_at DESC);
CREATE INDEX connector_delivery_attempts_delivery_idx
    ON connector_delivery_attempts (organization_id, project_id, delivery_id, attempt);

COMMENT ON TABLE connector_configurations IS
    'Materialized project connector policy; credentials remain external and are referenced by key only.';
COMMENT ON TABLE connector_configuration_events IS
    'Append-only, attributable connector configuration history.';
COMMENT ON TABLE connector_deliveries IS
    'Idempotent connector work queue with retry, lease recovery, and dead-letter state.';
COMMENT ON TABLE connector_delivery_attempts IS
    'Append-only evidence for every external delivery attempt and rate-limit decision.';
