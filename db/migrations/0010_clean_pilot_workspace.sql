-- Keep the production pilot tenant separate from deterministic development/demo data.
-- Cognito users are issued the organization UUID below and therefore cannot see the
-- historical AURORA-2 development seed in organization ...0001.
INSERT INTO organizations (id, slug, name)
VALUES (
    '00000000-0000-4000-8000-000000000002',
    'openrm',
    'OpenRM'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO projects (id, organization_id, key, name, description)
VALUES (
    '00000000-0000-4000-8000-000000000102',
    '00000000-0000-4000-8000-000000000002',
    'OPENRM',
    'OpenRM',
    'Clean controlled workspace for the OpenRM pilot.'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO artifact_types (organization_id, project_id, key, name)
VALUES (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000102',
    'REQUIREMENT',
    'Requirement'
)
ON CONFLICT (organization_id, project_id, key) DO NOTHING;

INSERT INTO folders (organization_id, project_id, name, created_by)
VALUES (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000102',
    'Requirements',
    'system:pilot-bootstrap'
)
ON CONFLICT (organization_id, project_id, parent_id, name) DO NOTHING;

INSERT INTO custom_attribute_definitions (
    organization_id, project_id, key, label, value_type, required, config, created_by
)
VALUES (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000102',
    'priority',
    'Priority',
    'enum',
    false,
    '{"options":["low","medium","high","critical"]}'::jsonb,
    'system:pilot-bootstrap'
)
ON CONFLICT (organization_id, project_id, key) DO NOTHING;

INSERT INTO relationship_types (
    organization_id, project_id, key, name,
    source_artifact_type_id, target_artifact_type_id,
    max_targets_per_source, max_sources_per_target, propagates_suspect
)
SELECT
    artifact_types.organization_id,
    artifact_types.project_id,
    defaults.key,
    defaults.name,
    artifact_types.id,
    artifact_types.id,
    defaults.max_targets,
    defaults.max_sources,
    true
FROM artifact_types
CROSS JOIN (
    VALUES
        ('DECOMPOSES_TO', 'Decomposes to', NULL::integer, 1),
        ('DEPENDS_ON', 'Depends on', NULL::integer, NULL::integer)
) AS defaults(key, name, max_targets, max_sources)
WHERE artifact_types.organization_id = '00000000-0000-4000-8000-000000000002'
  AND artifact_types.project_id = '00000000-0000-4000-8000-000000000102'
  AND artifact_types.key = 'REQUIREMENT'
ON CONFLICT (organization_id, project_id, key) DO NOTHING;
