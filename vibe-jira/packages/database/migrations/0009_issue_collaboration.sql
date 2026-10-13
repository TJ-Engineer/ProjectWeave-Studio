CREATE TABLE comments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  issue_id uuid NOT NULL REFERENCES issues(id),
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX comments_issue_timeline
  ON comments (issue_id, created_at, id);

CREATE TABLE comment_mentions (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (comment_id, user_id)
);

CREATE INDEX comment_mentions_user
  ON comment_mentions (user_id, comment_id);

CREATE TABLE issue_watchers (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL CHECK (state IN ('WATCHING', 'MUTED')),
  source text NOT NULL CHECK (source IN ('AUTO', 'EXPLICIT')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_id, user_id)
);

CREATE INDEX issue_watchers_user
  ON issue_watchers (user_id, issue_id)
  WHERE state = 'WATCHING';

ALTER TABLE issue_events
  DROP CONSTRAINT issue_events_event_type_check;

ALTER TABLE issue_events
  ADD CONSTRAINT issue_events_event_type_check
  CHECK (event_type IN ('CREATED', 'TRANSITIONED', 'REORDERED', 'UPDATED', 'DELETED', 'RESTORED', 'COMMENTED'));
