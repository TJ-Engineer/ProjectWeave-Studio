ALTER TABLE pages
  ADD COLUMN lifecycle_before_page_id uuid,
  ADD COLUMN lifecycle_after_page_id uuid;

ALTER TABLE pages
  ADD CONSTRAINT pages_lifecycle_before_same_space
  FOREIGN KEY (organization_id, space_id, lifecycle_before_page_id)
  REFERENCES pages(organization_id, space_id, id),
  ADD CONSTRAINT pages_lifecycle_after_same_space
  FOREIGN KEY (organization_id, space_id, lifecycle_after_page_id)
  REFERENCES pages(organization_id, space_id, id),
  ADD CONSTRAINT pages_active_lifecycle_position_clear
  CHECK (
    state <> 'ACTIVE'
    OR (
      lifecycle_before_page_id IS NULL
      AND lifecycle_after_page_id IS NULL
    )
  );

COMMENT ON COLUMN pages.lifecycle_before_page_id IS
  'Nearest active sibling before a lifecycle root when it left active navigation.';

COMMENT ON COLUMN pages.lifecycle_after_page_id IS
  'Nearest active sibling after a lifecycle root when it left active navigation.';

