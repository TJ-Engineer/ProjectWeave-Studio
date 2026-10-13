ALTER TABLE users DROP CONSTRAINT users_state_check;
ALTER TABLE users
  ADD CONSTRAINT users_state_check
  CHECK (state IN ('INVITED', 'ACTIVE', 'INACTIVE'));

ALTER TABLE users
  ADD COLUMN oidc_issuer text,
  ADD COLUMN oidc_subject text;

CREATE UNIQUE INDEX users_oidc_identity
  ON users (oidc_issuer, oidc_subject)
  WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;

CREATE TABLE user_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX one_open_invitation_per_user
  ON user_invitations (user_id)
  WHERE accepted_at IS NULL;

CREATE INDEX user_invitations_expiry
  ON user_invitations (expires_at)
  WHERE accepted_at IS NULL;
