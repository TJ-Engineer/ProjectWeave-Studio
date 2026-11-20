CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
    name text NOT NULL CHECK (length(trim(name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer text NOT NULL,
    subject text NOT NULL,
    display_name text,
    email text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, subject)
);

CREATE TABLE organization_memberships (
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_identity_id uuid NOT NULL REFERENCES user_identities(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('administrator', 'author', 'reviewer', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_identity_id)
);

CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    key text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9-]{1,15}$'),
    name text NOT NULL CHECK (length(trim(name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, key),
    UNIQUE (organization_id, id)
);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id uuid,
    actor_subject text NOT NULL,
    event_type text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX audit_events_tenant_time_idx
    ON audit_events (organization_id, occurred_at DESC);
CREATE INDEX audit_events_aggregate_idx
    ON audit_events (organization_id, aggregate_type, aggregate_id, occurred_at);

CREATE TABLE outbox_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    topic text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    available_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    processed_at timestamptz,
    last_error text
);

CREATE INDEX outbox_messages_pending_idx
    ON outbox_messages (available_at, occurred_at)
    WHERE processed_at IS NULL;

COMMENT ON TABLE audit_events IS
    'Append-only controlled mutation evidence. UPDATE and DELETE are denied by application policy and a later dedicated database role.';
COMMENT ON TABLE outbox_messages IS
    'Transactional messages for indexing and connectors; consumers must be idempotent by message id.';

