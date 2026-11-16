#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SMOKE_PROJECT="${OPENRM_SMOKE_PROJECT:-openrm-portability-smoke}"
SMOKE_PORT="${OPENRM_SMOKE_PORT:-18080}"
SMOKE_POSTGRES_PORT="${OPENRM_SMOKE_POSTGRES_PORT:-15432}"
SMOKE_OBJECT_STORAGE_PORT="${OPENRM_SMOKE_OBJECT_STORAGE_PORT:-14566}"
BASE_URL="http://127.0.0.1:${SMOKE_PORT}"
ORGANIZATION_ID="00000000-0000-4000-8000-000000000001"
PILOT_ORGANIZATION_ID="00000000-0000-4000-8000-000000000002"

if [[ "${SMOKE_PROJECT}" != openrm-portability-smoke* ]]; then
  echo "OPENRM_SMOKE_PROJECT must begin with openrm-portability-smoke to protect non-test volumes." >&2
  exit 1
fi

for command_name in docker curl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required for the OpenRM container smoke test." >&2
    exit 1
  fi
done

cd "${PROJECT_DIR}"

compose() {
  OPENRM_PORT="${SMOKE_PORT}" \
  OPENRM_POSTGRES_PORT="${SMOKE_POSTGRES_PORT}" \
  OPENRM_OBJECT_STORAGE_PORT="${SMOKE_OBJECT_STORAGE_PORT}" \
    docker compose --project-name "${SMOKE_PROJECT}" "$@"
}

cleanup() {
  if [[ "${OPENRM_SMOKE_KEEP:-0}" == "1" ]]; then
    echo "Leaving ${SMOKE_PROJECT} running because OPENRM_SMOKE_KEEP=1."
    return
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

compose config --quiet
compose up --build --detach

for attempt in {1..120}; do
  if curl --fail --silent "${BASE_URL}/container-health" >/dev/null \
    && curl --fail --silent "${BASE_URL}/ready" >/dev/null; then
    break
  fi
  if [[ "${attempt}" -eq 120 ]]; then
    compose ps --all
    compose logs --no-color
    echo "The portable OpenRM stack did not become ready." >&2
    exit 1
  fi
  sleep 2
done

projects="$(curl --fail --silent \
  -H 'Authorization: Bearer dev:local-user' \
  -H "X-OpenRM-Organization: ${ORGANIZATION_ID}" \
  "${BASE_URL}/api/v1/projects")"
if [[ "${projects}" != *'"key":"OPENRM"'* ]]; then
  echo "The container bootstrap did not create the OPENRM project." >&2
  exit 1
fi
if [[ "${projects}" == *'"key":"AURORA-2"'* ]]; then
  echo "The historical AURORA demo project was not removed." >&2
  exit 1
fi

project_id="$(printf '%s' "${projects}" | sed -n 's/.*"id":"\([^"]*\)","key":"OPENRM".*/\1/p')"
if [[ -z "${project_id}" ]]; then
  echo "Unable to resolve the OPENRM project identifier." >&2
  exit 1
fi

requirements="$(curl --fail --silent \
  -H 'Authorization: Bearer dev:local-user' \
  -H "X-OpenRM-Organization: ${ORGANIZATION_ID}" \
  "${BASE_URL}/api/v1/projects/${project_id}/requirements?limit=1&offset=0")"
if [[ "${requirements}" != *'"total":60'* ]]; then
  echo "The containerized OPENRM project does not contain all 60 requirements." >&2
  exit 1
fi

delete_probe_key="regression/unlinked-delete-probe.txt"
delete_probe_full_key="organizations/${ORGANIZATION_ID}/projects/${project_id}/${delete_probe_key}"
compose exec -T object-storage awslocal s3api put-object \
  --bucket "${OPENRM_OBJECT_STORAGE_BUCKET:-openrm-controlled-objects}" \
  --key "${delete_probe_full_key}" \
  --body /etc/hostname >/dev/null

objects="$(curl --fail --silent \
  -H 'Authorization: Bearer dev:local-user' \
  -H "X-OpenRM-Organization: ${ORGANIZATION_ID}" \
  "${BASE_URL}/api/v1/projects/${project_id}/storage/objects")"
if [[ "${objects}" != *'"items":'* || "${objects}" != *'"prefix":'* ]]; then
  echo "The S3-compatible project object inventory was unavailable: ${objects}" >&2
  exit 1
fi
if [[ "${objects}" != *"${delete_probe_key}"* || "${objects}" != *'"linked":false'* ]]; then
  echo "The unlinked object deletion probe was not inventoried correctly: ${objects}" >&2
  exit 1
fi

delete_response="$(curl --fail --silent --request DELETE \
  -H 'Authorization: Bearer dev:local-user' \
  -H "X-OpenRM-Organization: ${ORGANIZATION_ID}" \
  --get --data-urlencode "key=${delete_probe_key}" \
  "${BASE_URL}/api/v1/projects/${project_id}/storage/objects")"
if [[ "${delete_response}" != *'"deleted":true'* || "${delete_response}" != *'"version_id":'* ]]; then
  echo "The unlinked object deletion response was unexpected: ${delete_response}" >&2
  exit 1
fi

objects_after_delete="$(curl --fail --silent \
  -H 'Authorization: Bearer dev:local-user' \
  -H "X-OpenRM-Organization: ${ORGANIZATION_ID}" \
  "${BASE_URL}/api/v1/projects/${project_id}/storage/objects")"
if [[ "${objects_after_delete}" == *"${delete_probe_key}"* ]]; then
  echo "The deleted object remained in the project inventory: ${objects_after_delete}" >&2
  exit 1
fi

pilot_projects="$(curl --fail --silent \
  -H 'Authorization: Bearer dev:local-user' \
  -H "X-OpenRM-Organization: ${PILOT_ORGANIZATION_ID}" \
  "${BASE_URL}/api/v1/projects")"
pilot_project_id="$(printf '%s' "${pilot_projects}" | sed -n 's/.*"id":"\([^"]*\)","key":"OPENRM".*/\1/p')"
if [[ -z "${pilot_project_id}" ]]; then
  echo "The clean pilot migration did not create the isolated OPENRM workspace." >&2
  exit 1
fi

pilot_requirements="$(curl --fail --silent \
  -H 'Authorization: Bearer dev:local-user' \
  -H "X-OpenRM-Organization: ${PILOT_ORGANIZATION_ID}" \
  "${BASE_URL}/api/v1/projects/${pilot_project_id}/requirements?limit=1&offset=0")"
if [[ "${pilot_requirements}" != *'"total":0'* ]]; then
  echo "The clean pilot workspace unexpectedly contains requirements." >&2
  exit 1
fi

for service_name in api web; do
  container_id="$(compose ps --quiet "${service_name}")"
  container_user="$(docker inspect --format '{{.Config.User}}' "${container_id}")"
  read_only="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "${container_id}")"
  cap_drop="$(docker inspect --format '{{json .HostConfig.CapDrop}}' "${container_id}")"
  if [[ -z "${container_user}" || "${container_user}" == "0" || "${container_user}" == "root" ]]; then
    echo "${service_name} is not running as an explicit non-root user." >&2
    exit 1
  fi
  if [[ "${read_only}" != "true" ]]; then
    echo "${service_name} does not have a read-only root filesystem." >&2
    exit 1
  fi
  if [[ "${cap_drop}" != *'ALL'* ]]; then
    echo "${service_name} does not drop all Linux capabilities." >&2
    exit 1
  fi
done

echo "Portable OpenRM stack verified at ${BASE_URL}: web, API, PostgreSQL, S3-compatible object storage, migrations, isolated blank pilot workspace, 60-requirement development bootstrap, and container hardening passed."
