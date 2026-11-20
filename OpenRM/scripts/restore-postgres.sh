#!/usr/bin/env bash
set -euo pipefail

backup_path="${1:-}"
target_url="${2:-${RECOVERY_DATABASE_URL:-}}"
if [[ -z "${backup_path}" || -z "${target_url}" ]]; then
  echo 'usage: restore-postgres.sh <backup.dump> <target-database-url>' >&2
  exit 1
fi
if [[ ! -f "${backup_path}" ]]; then
  echo "Backup does not exist: ${backup_path}" >&2
  exit 1
fi

if [[ -n "${POSTGRES_CONTAINER:-}" ]]; then
  host_port="${POSTGRES_HOST_PORT:-5432}"
  container_url="${target_url/127.0.0.1:${host_port}/127.0.0.1:5432}"
  container_backup="/tmp/openrm-restore-${RANDOM}-${RANDOM}.dump"
  docker cp "${backup_path}" "${POSTGRES_CONTAINER}:${container_backup}" > /dev/null
  docker exec "${POSTGRES_CONTAINER}" pg_restore "${container_backup}" \
    --dbname="${container_url}" --clean --if-exists --no-owner \
    --no-privileges --exit-on-error
  docker exec "${POSTGRES_CONTAINER}" psql "${container_url}" \
    -v ON_ERROR_STOP=1 -c 'SELECT 1' > /dev/null
  docker exec "${POSTGRES_CONTAINER}" rm -f "${container_backup}"
else
  pg_restore "${backup_path}" \
    --dbname="${target_url}" \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges \
    --exit-on-error
  psql "${target_url}" -v ON_ERROR_STOP=1 -c 'SELECT 1' > /dev/null
fi
echo 'PostgreSQL restore completed and accepted queries.'
