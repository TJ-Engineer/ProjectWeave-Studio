#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

for command_name in docker cargo npm; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "${command_name} is required for the OpenRM development environment." >&2
    exit 1
  fi
done

cd "${PROJECT_DIR}"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

docker compose up -d postgres

echo "Waiting for PostgreSQL..."
for attempt in {1..30}; do
  if docker compose exec -T postgres pg_isready -U openrm -d openrm >/dev/null 2>&1; then
    break
  fi
  if [[ "${attempt}" -eq 30 ]]; then
    echo "PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 1
done

npm ci
npm run generate:api
cargo run -p openrm-api --bin migrate

echo
echo "OpenRM foundation is ready."
echo "  Web: npm run dev"
echo "  API: cargo run -p openrm-api"
echo "  Check: npm run check && cargo test --workspace"
echo "  Stop: docker compose down"

