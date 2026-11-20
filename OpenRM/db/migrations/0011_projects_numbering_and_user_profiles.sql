-- Close the pilot feedback gaps without replacing any existing project or identity data.
ALTER TABLE projects
    ADD COLUMN requirement_prefix text,
    ADD COLUMN next_requirement_number bigint NOT NULL DEFAULT 1;

WITH normalized AS (
    SELECT id,
           CASE
               WHEN id = '00000000-0000-4000-8000-000000000102'::uuid THEN 'ORM'
               WHEN length(regexp_replace(key, '[^A-Z0-9]', '', 'g')) >= 2
                   THEN left(regexp_replace(key, '[^A-Z0-9]', '', 'g'), 8)
               ELSE left(regexp_replace(key, '[^A-Z0-9]', '', 'g') || 'RM', 8)
           END AS prefix
    FROM projects
)
UPDATE projects
SET requirement_prefix = normalized.prefix
FROM normalized
WHERE projects.id = normalized.id;

ALTER TABLE projects
    ALTER COLUMN requirement_prefix SET NOT NULL,
    ADD CONSTRAINT projects_requirement_prefix_unique
        UNIQUE (organization_id, requirement_prefix),
    ADD CONSTRAINT projects_requirement_prefix_format
        CHECK (requirement_prefix ~ '^[A-Z][A-Z0-9]{1,7}$'),
    ADD CONSTRAINT projects_next_requirement_number_positive
        CHECK (next_requirement_number > 0);

-- Reserve numbers already used by requirements that match the newly configured prefix.
UPDATE projects project
SET next_requirement_number = existing.next_number
FROM (
    SELECT p.id,
           COALESCE(max(substring(a.key FROM '([0-9]+)$')::bigint) + 1, 1) AS next_number
    FROM projects p
    LEFT JOIN artifacts a
      ON a.organization_id = p.organization_id
     AND a.project_id = p.id
     AND a.key ~ ('^' || p.requirement_prefix || '-[0-9]+$')
    GROUP BY p.id
) existing
WHERE project.id = existing.id;

ALTER TABLE user_identities
    ADD COLUMN title text,
    ADD COLUMN department text,
    ADD COLUMN bio text,
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE user_identities
    ADD CONSTRAINT user_identities_title_length
        CHECK (title IS NULL OR length(title) <= 160),
    ADD CONSTRAINT user_identities_department_length
        CHECK (department IS NULL OR length(department) <= 160),
    ADD CONSTRAINT user_identities_bio_length
        CHECK (bio IS NULL OR length(bio) <= 2000);

CREATE INDEX user_identities_email_idx
    ON user_identities (lower(email))
    WHERE email IS NOT NULL;

COMMENT ON COLUMN projects.requirement_prefix IS
    'Administrator-selected prefix used for server-assigned requirement keys.';
COMMENT ON COLUMN projects.next_requirement_number IS
    'Next project-local requirement number, advanced atomically during creation.';
COMMENT ON COLUMN user_identities.bio IS
    'OpenRM-managed profile text; authentication credentials remain in the external identity provider.';
