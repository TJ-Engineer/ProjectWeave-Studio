CREATE TABLE review_packages (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    sequence integer NOT NULL CHECK (sequence > 0),
    baseline_id uuid NOT NULL,
    title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    description text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
    status text NOT NULL CHECK (status IN ('draft', 'in_review', 'changes_requested', 'approved', 'closed')),
    due_at timestamptz,
    required_approvals integer NOT NULL CHECK (required_approvals > 0),
    current_round integer NOT NULL DEFAULT 0 CHECK (current_round >= 0),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT review_packages_project_tenant_fk
        FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT review_packages_baseline_tenant_fk
        FOREIGN KEY (organization_id, project_id, baseline_id)
        REFERENCES baselines(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, sequence),
    UNIQUE (organization_id, project_id, id)
);

CREATE TABLE review_package_events (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    round integer NOT NULL CHECK (round >= 0),
    event_type text NOT NULL CHECK (event_type IN ('created', 'started', 'changes_requested', 'approved', 'closed')),
    status text NOT NULL CHECK (status IN ('draft', 'in_review', 'changes_requested', 'approved', 'closed')),
    rationale text,
    actor_subject text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT review_package_events_review_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id)
        REFERENCES review_packages(organization_id, project_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, version)
);

CREATE TABLE review_participants (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    subject text NOT NULL,
    role_label text NOT NULL CHECK (length(trim(role_label)) BETWEEN 1 AND 120),
    required boolean NOT NULL DEFAULT true,
    assigned_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT review_participants_review_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id)
        REFERENCES review_packages(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT review_participants_membership_tenant_fk
        FOREIGN KEY (organization_id, project_id, subject)
        REFERENCES project_memberships(organization_id, project_id, subject)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, subject),
    UNIQUE (organization_id, project_id, review_id, id)
);

CREATE TABLE review_comments (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    target_artifact_id uuid,
    target_revision_id uuid,
    body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
    blocking boolean NOT NULL DEFAULT false,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT review_comments_target_pair CHECK (
        (target_artifact_id IS NULL AND target_revision_id IS NULL)
        OR (target_artifact_id IS NOT NULL AND target_revision_id IS NOT NULL)
    ),
    CONSTRAINT review_comments_review_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id)
        REFERENCES review_packages(organization_id, project_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT review_comments_target_revision_tenant_fk
        FOREIGN KEY (organization_id, project_id, target_artifact_id, target_revision_id)
        REFERENCES artifact_revisions(organization_id, project_id, artifact_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, id)
);

CREATE TABLE review_comment_resolutions (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    comment_id uuid NOT NULL,
    resolution text NOT NULL CHECK (length(trim(resolution)) BETWEEN 1 AND 4000),
    resolved_by text NOT NULL,
    resolved_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT review_comment_resolutions_comment_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id, comment_id)
        REFERENCES review_comments(organization_id, project_id, review_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, comment_id)
);

CREATE TABLE review_decisions (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    project_id uuid NOT NULL,
    review_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    round integer NOT NULL CHECK (round > 0),
    decision text NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
    comment text NOT NULL DEFAULT '' CHECK (length(comment) <= 4000),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),
    signing_algorithm text NOT NULL,
    signing_key_id text NOT NULL,
    decided_by text NOT NULL,
    decided_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT review_decisions_participant_tenant_fk
        FOREIGN KEY (organization_id, project_id, review_id, participant_id)
        REFERENCES review_participants(organization_id, project_id, review_id, id)
        ON DELETE RESTRICT,
    UNIQUE (organization_id, project_id, review_id, participant_id, round)
);

CREATE TRIGGER review_package_events_append_only
    BEFORE UPDATE OR DELETE ON review_package_events
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER review_participants_append_only
    BEFORE UPDATE OR DELETE ON review_participants
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER review_comments_append_only
    BEFORE UPDATE OR DELETE ON review_comments
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER review_comment_resolutions_append_only
    BEFORE UPDATE OR DELETE ON review_comment_resolutions
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();
CREATE TRIGGER review_decisions_append_only
    BEFORE UPDATE OR DELETE ON review_decisions
    FOR EACH ROW EXECUTE FUNCTION prevent_controlled_history_change();

CREATE INDEX review_packages_project_sequence_idx
    ON review_packages (organization_id, project_id, sequence DESC);
CREATE INDEX review_package_events_history_idx
    ON review_package_events (organization_id, project_id, review_id, version DESC);
CREATE INDEX review_comments_package_idx
    ON review_comments (organization_id, project_id, review_id, created_at);
CREATE INDEX review_decisions_package_idx
    ON review_decisions (organization_id, project_id, review_id, round, decided_at);

COMMENT ON TABLE review_packages IS
    'Materialized state for baseline-bound controlled review packages.';
COMMENT ON TABLE review_package_events IS
    'Append-only review lifecycle evidence used to reconstruct every status transition.';
COMMENT ON TABLE review_decisions IS
    'Append-only signed participant decisions bound to one review round and immutable baseline.';
