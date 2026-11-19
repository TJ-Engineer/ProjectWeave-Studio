#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo 'DATABASE_URL is required' >&2
  exit 1
fi

backup_path="${1:-}"
if [[ -z "${backup_path}" ]]; then
  echo 'usage: backup-postgres.sh <backup.dump>' >&2
  exit 1
fi

backup_directory="$(dirname "${backup_path}")"
mkdir -p "${backup_directory}"
umask 077
if [[ -n "${POSTGRES_CONTAINER:-}" ]]; then
  host_port="${POSTGRES_HOST_PORT:-5432}"
  container_url="${DATABASE_URL/127.0.0.1:${host_port}/127.0.0.1:5432}"
  container_backup="/tmp/openrm-backup-${RANDOM}-${RANDOM}.dump"
  docker exec "${POSTGRES_CONTAINER}" pg_dump "${container_url}" \
    --format=custom --compress=9 --no-owner --no-privileges \
    --file="${container_backup}"
  docker exec "${POSTGRES_CONTAINER}" pg_restore --list "${container_backup}" > /dev/null
  docker cp "${POSTGRES_CONTAINER}:${container_backup}" "${backup_path}" > /dev/null
  docker exec "${POSTGRES_CONTAINER}" rm -f "${container_backup}"
else
  pg_dump "${DATABASE_URL}" \
    --format=custom \
    --compress=9 \
    --no-owner \
    --no-privileges \
    --file="${backup_path}"
  pg_restore --list "${backup_path}" > /dev/null
fi
echo "Verified PostgreSQL backup: ${backup_path}"
