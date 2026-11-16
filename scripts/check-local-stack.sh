#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BASE_URL="${OPENRM_LOCAL_BASE_URL:-http://127.0.0.1:${OPENRM_PORT:-8080}}"
PILOT_ORGANIZATION_ID="00000000-0000-4000-8000-000000000002"

for command_name in docker curl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required for the OpenRM local regression check." >&2
    exit 1
  fi
done

cd "${PROJECT_DIR}"

for service_name in object-storage postgres api web; do
  container_id="$(docker compose ps --quiet "${service_name}")"
  if [[ -z "${container_id}" ]]; then
    echo "The ${service_name} service is not running. Run npm run local:up first." >&2
    exit 1
  fi

  container_state="$(docker inspect --format '{{.State.Status}}' "${container_id}")"
  if [[ "${container_state}" != "running" ]]; then
    echo "The ${service_name} service is ${container_state}, not running." >&2
    exit 1
  fi
done

health="$(curl --fail --silent "${BASE_URL}/health")"
ready="$(curl --fail --silent "${BASE_URL}/ready")"
config="$(curl --fail --silent "${BASE_URL}/openrm-config.json")"

if [[ "${health}" != *'"status":"ok"'* ]]; then
  echo "The local API health response was unexpected: ${health}" >&2
  exit 1
fi
if [[ "${ready}" != *'"status":"ready"'* || "${ready}" != *'"database":"available"'* ]]; then
  echo "The local API readiness response was unexpected: ${ready}" >&2
  exit 1
fi
if [[ "${config}" != *'"authMode":"development"'* && "${config}" != *'"authMode": "development"'* ]]; then
  echo "The local web configuration is not using development authentication." >&2
  exit 1
fi
if [[ "${config}" != *"${PILOT_ORGANIZATION_ID}"* || "${config}" != *'"projectKey":"OPENRM"'* && "${config}" != *'"projectKey": "OPENRM"'* ]]; then
  echo "The local web configuration is not targeting the clean OpenRM workspace." >&2
  exit 1
fi
projects="$(curl --fail --silent \
  -H 'Authorization: Bearer dev:local-user' \
  -H "X-OpenRM-Organization: ${PILOT_ORGANIZATION_ID}" \
  "${BASE_URL}/api/v1/projects")"
if [[ "${projects}" != *'"key":"OPENRM"'* || "${projects}" != *'"requirement_prefix":"ORM"'* ]]; then
  echo "The local clean workspace or ORM requirement prefix is missing: ${projects}" >&2
  exit 1
fi
if [[ "${projects}" == *'"key":"KANBAN"'* || "${projects}" == *'"key":"AURORA-2"'* ]]; then
  echo "A retired demo or UI-test project is still visible: ${projects}" >&2
  exit 1
fi

project_id="$(printf '%s' "${projects}" | sed -n 's/.*"id":"\([^"]*\)","key":"OPENRM".*/\1/p')"
objects="$(curl --fail --silent \
  -H 'Authorization: Bearer dev:local-user' \
  -H "X-OpenRM-Organization: ${PILOT_ORGANIZATION_ID}" \
  "${BASE_URL}/api/v1/projects/${project_id}/storage/objects")"
if [[ "${objects}" != *'"items":'* || "${objects}" != *'"prefix":'* ]]; then
  echo "The local object-storage inventory response was unexpected: ${objects}" >&2
  exit 1
fi

unauthenticated_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -H "X-OpenRM-Organization: ${PILOT_ORGANIZATION_ID}" \
  "${BASE_URL}/api/v1/projects")"
if [[ "${unauthenticated_status}" != "401" ]]; then
  echo "The unauthenticated projects boundary returned ${unauthenticated_status}, not 401." >&2
  exit 1
fi

echo "Local OpenRM stack verified at ${BASE_URL}: web, API, PostgreSQL, S3-compatible object storage, migrations, ORM prefix, development authentication, and the unauthenticated API boundary passed."
