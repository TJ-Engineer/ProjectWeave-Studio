ALTER TABLE space_grants RENAME TO space_memberships;

ALTER TABLE drafts RENAME COLUMN owner_id TO principal_id;

ALTER TABLE spaces
  ADD COLUMN membership_version integer NOT NULL DEFAULT 1
    CHECK (membership_version > 0);

ALTER TABLE space_memberships
  ADD CONSTRAINT space_memberships_organization_member
  FOREIGN KEY (organization_id, user_id)
  REFERENCES memberships(organization_id, user_id),
  ADD CONSTRAINT space_memberships_tenant_space_user_unique
  UNIQUE (organization_id, space_id, user_id);

ALTER TABLE pages
  ADD CONSTRAINT pages_tenant_space_id_unique
  UNIQUE (organization_id, space_id, id);

CREATE TABLE page_aliases (
  organization_id uuid NOT NULL,
  space_id uuid NOT NULL,
  page_id uuid NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, slug),
  FOREIGN KEY (organization_id, space_id, page_id)
    REFERENCES pages(organization_id, space_id, id),
  UNIQUE (organization_id, space_id, slug)
);

INSERT INTO page_aliases (organization_id, space_id, page_id, slug, created_at)
SELECT organization_id, space_id, id, slug, created_at
FROM pages;

CREATE TABLE page_restrictions (
  organization_id uuid NOT NULL,
  space_id uuid NOT NULL,
  page_id uuid PRIMARY KEY,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, space_id, page_id)
    REFERENCES pages(organization_id, space_id, id),
  FOREIGN KEY (organization_id, created_by)
    REFERENCES users(organization_id, id),
  UNIQUE (organization_id, space_id, page_id)
);

CREATE TABLE page_restriction_members (
  organization_id uuid NOT NULL,
  space_id uuid NOT NULL,
  page_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id),
  FOREIGN KEY (organization_id, space_id, page_id)
    REFERENCES page_restrictions(organization_id, space_id, page_id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, space_id, user_id)
    REFERENCES space_memberships(organization_id, space_id, user_id)
    ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION require_active_space_member()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM users u
    JOIN memberships m
      ON m.organization_id = u.organization_id
     AND m.user_id = u.id
    WHERE u.organization_id = NEW.organization_id
      AND u.id = NEW.user_id
      AND u.state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'space membership requires an active organization member'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER space_memberships_require_active_member
BEFORE INSERT OR UPDATE OF organization_id, user_id ON space_memberships
FOR EACH ROW EXECUTE FUNCTION require_active_space_member();

CREATE OR REPLACE FUNCTION require_active_restriction_member()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM space_memberships sm
    JOIN users u
      ON u.organization_id = sm.organization_id
     AND u.id = sm.user_id
    WHERE sm.organization_id = NEW.organization_id
      AND sm.space_id = NEW.space_id
      AND sm.user_id = NEW.user_id
      AND u.state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'page restriction requires an active space member'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER page_restriction_members_require_active_member
BEFORE INSERT OR UPDATE ON page_restriction_members
FOR EACH ROW EXECUTE FUNCTION require_active_restriction_member();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM spaces s
    WHERE NOT EXISTS (
      SELECT 1
      FROM space_memberships sm
      JOIN users u
        ON u.organization_id = sm.organization_id
       AND u.id = sm.user_id
      WHERE sm.organization_id = s.organization_id
        AND sm.space_id = s.id
        AND sm.role = 'ADMIN'
        AND u.state = 'ACTIVE'
    )
  ) THEN
    RAISE EXCEPTION 'every existing space must have an active administrator';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION require_space_admin()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_organization_id uuid;
  checked_space_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'spaces' THEN
    checked_organization_id := NEW.organization_id;
    checked_space_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    checked_organization_id := OLD.organization_id;
    checked_space_id := OLD.space_id;
  ELSE
    checked_organization_id := NEW.organization_id;
    checked_space_id := NEW.space_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM spaces s
    WHERE s.organization_id = checked_organization_id
      AND s.id = checked_space_id
  ) AND NOT EXISTS (
    SELECT 1
    FROM space_memberships sm
    JOIN users u
      ON u.organization_id = sm.organization_id
     AND u.id = sm.user_id
    WHERE sm.organization_id = checked_organization_id
      AND sm.space_id = checked_space_id
      AND sm.role = 'ADMIN'
      AND u.state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'space must retain an active administrator'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER spaces_require_admin
AFTER INSERT ON spaces
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_space_admin();

CREATE CONSTRAINT TRIGGER space_memberships_require_admin
AFTER INSERT OR UPDATE OR DELETE ON space_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_space_admin();

CREATE INDEX page_aliases_page_idx
  ON page_aliases (organization_id, page_id);
CREATE INDEX page_restriction_members_user_idx
  ON page_restriction_members (organization_id, user_id, page_id);
