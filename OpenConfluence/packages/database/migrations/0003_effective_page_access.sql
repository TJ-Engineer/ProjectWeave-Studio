CREATE OR REPLACE FUNCTION has_effective_page_access(
  requested_organization_id uuid,
  requested_user_id uuid,
  target_page_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE page_ancestors AS (
    SELECT p.id, p.organization_id, p.space_id, p.parent_id,
           p.current_revision_id, p.created_by
    FROM pages p
    WHERE p.organization_id = requested_organization_id
      AND p.id = target_page_id
      AND p.state = 'ACTIVE'

    UNION

    SELECT parent.id, parent.organization_id, parent.space_id,
           parent.parent_id, parent.current_revision_id, parent.created_by
    FROM pages parent
    JOIN page_ancestors child
      ON child.organization_id = parent.organization_id
     AND child.space_id = parent.space_id
     AND child.parent_id = parent.id
  ),
  request_context AS (
    SELECT target.current_revision_id, target.created_by,
           organization_member.organization_role,
           space_member.role AS space_role
    FROM page_ancestors target
    JOIN users requested_user
      ON requested_user.organization_id = target.organization_id
     AND requested_user.id = requested_user_id
     AND requested_user.state = 'ACTIVE'
    JOIN memberships organization_member
      ON organization_member.organization_id = requested_user.organization_id
     AND organization_member.user_id = requested_user.id
    LEFT JOIN space_memberships space_member
      ON space_member.organization_id = target.organization_id
     AND space_member.space_id = target.space_id
     AND space_member.user_id = requested_user.id
    WHERE target.id = target_page_id
  )
  SELECT COALESCE((
    SELECT CASE
      WHEN context.current_revision_id IS NULL THEN
        context.created_by = requested_user_id
        AND (
          context.organization_role = 'ADMIN'
          OR context.space_role IS NOT NULL
        )
      WHEN context.organization_role = 'ADMIN'
        OR context.space_role = 'ADMIN' THEN true
      WHEN context.space_role IS NULL THEN false
      ELSE NOT EXISTS (
        SELECT 1
        FROM page_ancestors ancestor
        JOIN page_restrictions restriction
          ON restriction.organization_id = ancestor.organization_id
         AND restriction.space_id = ancestor.space_id
         AND restriction.page_id = ancestor.id
        WHERE NOT EXISTS (
          SELECT 1
          FROM page_restriction_members allowed_member
          WHERE allowed_member.organization_id = restriction.organization_id
            AND allowed_member.space_id = restriction.space_id
            AND allowed_member.page_id = restriction.page_id
            AND allowed_member.user_id = requested_user_id
        )
      )
    END
    FROM request_context context
  ), false);
$$;

COMMENT ON FUNCTION has_effective_page_access(uuid, uuid, uuid) IS
  'Returns non-leaking page visibility after active identity, private space membership, private unpublished ownership, administrator bypass, and inherited restrictive allowlists are applied.';
