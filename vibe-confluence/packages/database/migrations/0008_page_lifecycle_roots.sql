ALTER TABLE pages
  ADD COLUMN lifecycle_root_id uuid;

UPDATE pages
   SET lifecycle_root_id = id
 WHERE state <> 'ACTIVE';

ALTER TABLE pages
  ADD CONSTRAINT pages_lifecycle_root_same_space
  FOREIGN KEY (organization_id, space_id, lifecycle_root_id)
  REFERENCES pages(organization_id, space_id, id),
  ADD CONSTRAINT pages_lifecycle_root_matches_state
  CHECK ((state = 'ACTIVE') = (lifecycle_root_id IS NULL));

CREATE INDEX pages_lifecycle_root_idx
  ON pages (organization_id, space_id, lifecycle_root_id, state);

COMMENT ON COLUMN pages.lifecycle_root_id IS
  'Inactive transition root; separates independently archived or trashed branches that later share the same state.';

