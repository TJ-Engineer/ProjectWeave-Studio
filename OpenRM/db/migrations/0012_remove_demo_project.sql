-- Remove the historical deterministic UI-demo project. The real OpenRM
-- self-verification project and clean pilot organization are preserved.
DELETE FROM projects
WHERE id = '00000000-0000-4000-8000-000000000101'
  AND organization_id = '00000000-0000-4000-8000-000000000001'
  AND key = 'AURORA-2';
