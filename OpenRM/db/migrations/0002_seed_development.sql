INSERT INTO organizations (id, slug, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'openrm-local', 'OpenRM Local Development')
ON CONFLICT (id) DO NOTHING;

INSERT INTO projects (id, organization_id, key, name)
VALUES (
    '00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000001',
    'AURORA-2',
    'Aurora Flight Computer'
)
ON CONFLICT (id) DO NOTHING;

