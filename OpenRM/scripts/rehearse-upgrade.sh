#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${UPGRADE_DATABASE_URL:-}" ]]; then
  echo 'UPGRADE_DATABASE_URL is required' >&2
  exit 1
fi

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

before="$(psql_scalar "${UPGRADE_DATABASE_URL}" -tAc 'SELECT count(*) FROM _sqlx_migrations')"
DATABASE_URL="${UPGRADE_DATABASE_URL}" cargo run -p openrm-api --bin migrate > /dev/null
DATABASE_URL="${UPGRADE_DATABASE_URL}" cargo run -p openrm-api --bin migrate > /dev/null
after="$(psql_scalar "${UPGRADE_DATABASE_URL}" -tAc 'SELECT count(*) FROM _sqlx_migrations')"
latest="$(find db/migrations -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"

test "${after}" -ge "${before}"
test "${after}" -eq "${latest}"
psql_scalar "${UPGRADE_DATABASE_URL}" -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM connector_configurations' > /dev/null
echo "Upgrade rehearsal passed: ${before} -> ${after} migrations, second application was idempotent."
