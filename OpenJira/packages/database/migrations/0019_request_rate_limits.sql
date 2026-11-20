CREATE TABLE request_rate_limits (
  scope text NOT NULL,
  key_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (scope, key_hash)
);

CREATE INDEX request_rate_limits_expiry
  ON request_rate_limits (window_started_at);
