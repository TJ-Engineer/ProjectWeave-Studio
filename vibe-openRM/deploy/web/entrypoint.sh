#!/bin/sh
set -eu

: "${OPENRM_AUTH_MODE:=development}"
: "${OPENRM_API_BASE_URL:=/}"
: "${OPENRM_ORGANIZATION_ID:=00000000-0000-4000-8000-000000000002}"
: "${OPENRM_PROJECT_ID:=00000000-0000-4000-8000-000000000102}"
: "${OPENRM_PROJECT_KEY:=OPENRM}"
: "${OPENRM_PROJECT_NAME:=OpenRM}"
: "${OPENRM_COGNITO_DOMAIN:=}"
: "${OPENRM_COGNITO_CLIENT_ID:=}"

if [ "${OPENRM_AUTH_MODE}" = "cognito" ]; then
    : "${OPENRM_COGNITO_DOMAIN:?set OPENRM_COGNITO_DOMAIN}"
    : "${OPENRM_COGNITO_CLIENT_ID:?set OPENRM_COGNITO_CLIENT_ID}"
fi

umask 077
printf '%s\n' \
    '{' \
    "  \"authMode\": \"${OPENRM_AUTH_MODE}\"," \
    "  \"apiBaseUrl\": \"${OPENRM_API_BASE_URL}\"," \
    "  \"organizationId\": \"${OPENRM_ORGANIZATION_ID}\"," \
    "  \"projectId\": \"${OPENRM_PROJECT_ID}\"," \
    "  \"projectKey\": \"${OPENRM_PROJECT_KEY}\"," \
    "  \"projectName\": \"${OPENRM_PROJECT_NAME}\"," \
    '  "cognito": {' \
    "    \"domain\": \"${OPENRM_COGNITO_DOMAIN}\"," \
    "    \"clientId\": \"${OPENRM_COGNITO_CLIENT_ID}\"," \
    '    "scopes": ["openid", "email", "profile"]' \
    '  }' \
    '}' \
    > /dev/shm/openrm-config.json

exec /docker-entrypoint.sh "$@"
