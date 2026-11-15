CREATE TABLE agent_api_tokens (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_api_tokens_active_user
  ON agent_api_tokens (organization_id, user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX agent_api_tokens_expiry
  ON agent_api_tokens (expires_at)
  WHERE revoked_at IS NULL;
