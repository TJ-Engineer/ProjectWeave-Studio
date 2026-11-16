#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" || -z "${RECOVERY_DATABASE_URL:-}" ]]; then
  echo 'DATABASE_URL and RECOVERY_DATABASE_URL are required' >&2
  exit 1
fi

recovery_temp="$(mktemp -d)"
trap 'rm -rf "${recovery_temp}"' EXIT
backup_path="${recovery_temp}/openrm-recovery.dump"

psql_scalar() {
  local database_url="$1"
  shift
  if [[ -n "${POSTGRES_CONTAINER:-}" ]]; then
    local host_port="${POSTGRES_HOST_PORT:-5432}"
    local container_url="${database_url/127.0.0.1:${host_port}/127.0.0.1:5432}"
    docker exec "${POSTGRES_CONTAINER}" psql "${container_url}" "$@"
  else
    psql "${database_url}" "$@"
  fi
}

bash scripts/backup-postgres.sh "${backup_path}"
bash scripts/restore-postgres.sh "${backup_path}" "${RECOVERY_DATABASE_URL}"
DATABASE_URL="${RECOVERY_DATABASE_URL}" cargo run -p openrm-api --bin migrate > /dev/null

source_count="$(psql_scalar "${DATABASE_URL}" -tAc "SELECT (SELECT count(*) FROM projects) + (SELECT count(*) FROM artifact_revisions) + (SELECT count(*) FROM audit_events) + (SELECT count(*) FROM connector_delivery_attempts)")"
restored_count="$(psql_scalar "${RECOVERY_DATABASE_URL}" -tAc "SELECT (SELECT count(*) FROM projects) + (SELECT count(*) FROM artifact_revisions) + (SELECT count(*) FROM audit_events) + (SELECT count(*) FROM connector_delivery_attempts)")"
source_migrations="$(psql_scalar "${DATABASE_URL}" -tAc 'SELECT count(*) FROM _sqlx_migrations')"
restored_migrations="$(psql_scalar "${RECOVERY_DATABASE_URL}" -tAc 'SELECT count(*) FROM _sqlx_migrations')"

test "${source_count}" = "${restored_count}"
test "${source_migrations}" = "${restored_migrations}"
critical_table_count="$(psql_scalar "${RECOVERY_DATABASE_URL}" -v ON_ERROR_STOP=1 -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('audit_events','artifact_revisions','baselines','review_decisions','verification_results','connector_delivery_attempts')")"
test "${critical_table_count}" -eq 6
echo "Recovery rehearsal passed: ${restored_count} controlled rows across ${restored_migrations} migrations."
