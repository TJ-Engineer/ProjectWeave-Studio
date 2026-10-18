CREATE OR REPLACE FUNCTION require_space_admin()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_organization_id uuid;
  checked_space_id uuid;
  emergency_deactivation boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'spaces' THEN
    checked_organization_id := NEW.organization_id;
    checked_space_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    checked_organization_id := OLD.organization_id;
    checked_space_id := OLD.space_id;
    SELECT u.state = 'DEACTIVATED'
      INTO emergency_deactivation
      FROM users u
     WHERE u.organization_id = OLD.organization_id
       AND u.id = OLD.user_id;
  ELSE
    checked_organization_id := NEW.organization_id;
    checked_space_id := NEW.space_id;
  END IF;

  IF emergency_deactivation THEN
    RETURN NULL;
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

CREATE OR REPLACE FUNCTION revoke_deactivated_user_access()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'DEACTIVATED' AND NEW.state = 'DEACTIVATED' THEN
    UPDATE page_restrictions restriction
       SET version = restriction.version + 1, updated_at = now()
     WHERE restriction.organization_id = NEW.organization_id
       AND EXISTS (
         SELECT 1
           FROM page_restriction_members restriction_member
          WHERE restriction_member.organization_id = restriction.organization_id
            AND restriction_member.space_id = restriction.space_id
            AND restriction_member.page_id = restriction.page_id
            AND restriction_member.user_id = NEW.id
       );

    WITH removed_memberships AS (
      DELETE FROM space_memberships
       WHERE organization_id = NEW.organization_id
         AND user_id = NEW.id
       RETURNING organization_id, space_id
    )
    UPDATE spaces affected_space
       SET membership_version = affected_space.membership_version + 1
      FROM (
        SELECT DISTINCT organization_id, space_id
          FROM removed_memberships
      ) removed_space
     WHERE affected_space.organization_id = removed_space.organization_id
       AND affected_space.id = removed_space.space_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_revoke_access_on_deactivation
AFTER UPDATE OF state ON users
FOR EACH ROW EXECUTE FUNCTION revoke_deactivated_user_access();

UPDATE page_restrictions restriction
   SET version = restriction.version + 1, updated_at = now()
 WHERE EXISTS (
   SELECT 1
     FROM page_restriction_members restriction_member
     JOIN users deactivated_user
       ON deactivated_user.organization_id = restriction_member.organization_id
      AND deactivated_user.id = restriction_member.user_id
    WHERE restriction_member.organization_id = restriction.organization_id
      AND restriction_member.space_id = restriction.space_id
      AND restriction_member.page_id = restriction.page_id
      AND deactivated_user.state = 'DEACTIVATED'
 );

WITH removed_memberships AS (
  DELETE FROM space_memberships space_member
  USING users deactivated_user
  WHERE deactivated_user.organization_id = space_member.organization_id
    AND deactivated_user.id = space_member.user_id
    AND deactivated_user.state = 'DEACTIVATED'
  RETURNING space_member.organization_id, space_member.space_id
)
UPDATE spaces affected_space
   SET membership_version = affected_space.membership_version + 1
  FROM (
    SELECT DISTINCT organization_id, space_id
      FROM removed_memberships
  ) removed_space
 WHERE affected_space.organization_id = removed_space.organization_id
   AND affected_space.id = removed_space.space_id;

COMMENT ON FUNCTION revoke_deactivated_user_access() IS
  'Emergency deactivation removes direct space membership and cascades page grants. Reactivation requires explicit access decisions.';
