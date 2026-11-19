CREATE TABLE page_sibling_lists (
  organization_id uuid NOT NULL,
  space_id uuid NOT NULL,
  parent_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (organization_id, space_id, parent_id),
  FOREIGN KEY (organization_id, space_id)
    REFERENCES spaces(organization_id, id),
  FOREIGN KEY (organization_id, space_id, parent_id)
    REFERENCES pages(organization_id, space_id, id)
    ON DELETE CASCADE
);

INSERT INTO page_sibling_lists (organization_id, space_id, parent_id)
SELECT organization_id, id, NULL
  FROM spaces
UNION ALL
SELECT organization_id, space_id, id
  FROM pages;

ALTER TABLE pages
  ADD CONSTRAINT pages_parent_same_space
  FOREIGN KEY (organization_id, space_id, parent_id)
  REFERENCES pages(organization_id, space_id, id);

CREATE OR REPLACE FUNCTION initialize_space_root_sibling_list()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO page_sibling_lists (organization_id, space_id, parent_id)
  VALUES (NEW.organization_id, NEW.id, NULL);
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_initialize_root_sibling_list
AFTER INSERT ON spaces
FOR EACH ROW EXECUTE FUNCTION initialize_space_root_sibling_list();

CREATE OR REPLACE FUNCTION initialize_page_child_sibling_list()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE page_sibling_lists
     SET version = version + 1, updated_at = now()
   WHERE organization_id = NEW.organization_id
     AND space_id = NEW.space_id
     AND parent_id IS NOT DISTINCT FROM NEW.parent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'page parent sibling list is missing'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO page_sibling_lists (organization_id, space_id, parent_id)
  VALUES (NEW.organization_id, NEW.space_id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER pages_initialize_child_sibling_list
AFTER INSERT ON pages
FOR EACH ROW EXECUTE FUNCTION initialize_page_child_sibling_list();

CREATE INDEX page_sibling_lists_space_idx
  ON page_sibling_lists (organization_id, space_id, parent_id);

COMMENT ON TABLE page_sibling_lists IS
  'Optimistic-concurrency version for each root or direct-child sibling list.';
