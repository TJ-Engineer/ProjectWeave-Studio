ALTER TABLE organizations
  ADD COLUMN audit_retention_days integer NOT NULL DEFAULT 365
    CHECK (audit_retention_days BETWEEN 30 AND 3650),
  ADD COLUMN audit_retention_version integer NOT NULL DEFAULT 1
    CHECK (audit_retention_version > 0);

CREATE INDEX audit_events_organization_timeline
  ON audit_events (organization_id, created_at DESC, id DESC);

CREATE INDEX audit_events_organization_actor_timeline
  ON audit_events (organization_id, actor_id, created_at DESC, id DESC);

CREATE INDEX audit_events_organization_action_timeline
  ON audit_events (organization_id, action, created_at DESC, id DESC);

CREATE INDEX audit_events_organization_target_timeline
  ON audit_events (organization_id, target_type, target_id, created_at DESC, id DESC);

CREATE INDEX audit_events_organization_correlation
  ON audit_events (organization_id, correlation_id);
