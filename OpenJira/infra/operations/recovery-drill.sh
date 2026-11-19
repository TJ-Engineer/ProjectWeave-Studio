#!/bin/sh
set -eu

repository_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
backup_dir=$(mktemp -d "${TMPDIR:-/tmp}/vibe-jira-drill.XXXXXX")
drill_project="vibe-jira-drill-$$"

cleanup() {
  COMPOSE_PROJECT_NAME="$drill_project" PORT=3100 OBJECT_STORAGE_PORT=8433 \
    docker compose -f "$repository_dir/compose.yaml" down -v >/dev/null 2>&1 || true
  rm -rf "$backup_dir"
}
trap cleanup EXIT INT TERM

cd "$repository_dir"
source_counts=$(docker compose exec -T postgres psql \
  --username "${POSTGRES_USER:-vibe}" --dbname "${POSTGRES_DB:-vibe_jira}" \
  --tuples-only --no-align \
  --command "SELECT (SELECT count(*) FROM projects) || ':' || (SELECT count(*) FROM issues) || ':' || (SELECT count(*) FROM attachments);")
/bin/sh infra/operations/backup.sh "$backup_dir"

COMPOSE_PROJECT_NAME="$drill_project" PORT=3100 OBJECT_STORAGE_PORT=8433 \
  OBJECT_STORAGE_PUBLIC_ENDPOINT=http://localhost:8433 \
  docker compose up -d --wait postgres object-storage
COMPOSE_PROJECT_NAME="$drill_project" PORT=3100 OBJECT_STORAGE_PORT=8433 \
  OBJECT_STORAGE_PUBLIC_ENDPOINT=http://localhost:8433 \
  docker compose run --rm migrate
COMPOSE_PROJECT_NAME="$drill_project" PORT=3100 OBJECT_STORAGE_PORT=8433 \
  OBJECT_STORAGE_PUBLIC_ENDPOINT=http://localhost:8433 CONFIRM_RESTORE=RESTORE \
  /bin/sh infra/operations/restore.sh "$backup_dir"

restored_counts=$(COMPOSE_PROJECT_NAME="$drill_project" PORT=3100 OBJECT_STORAGE_PORT=8433 \
  OBJECT_STORAGE_PUBLIC_ENDPOINT=http://localhost:8433 \
  docker compose exec -T postgres psql \
  --username "${POSTGRES_USER:-vibe}" --dbname "${POSTGRES_DB:-vibe_jira}" \
  --tuples-only --no-align \
  --command "SELECT (SELECT count(*) FROM projects) || ':' || (SELECT count(*) FROM issues) || ':' || (SELECT count(*) FROM attachments);")

if [ "$source_counts" != "$restored_counts" ]; then
  echo "Recovery drill count mismatch: source=$source_counts restored=$restored_counts" >&2
  exit 1
fi

attempt=0
until curl --fail --silent http://127.0.0.1:3100/health/ready >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Recovery drill application did not become ready" >&2
    exit 1
  fi
  sleep 1
done

COMPOSE_PROJECT_NAME="$drill_project" PORT=3100 OBJECT_STORAGE_PORT=8433 \
  OBJECT_STORAGE_PUBLIC_ENDPOINT=http://object-storage:8333 \
  docker compose run --rm app recovery-verify

echo "Recovery drill passed with project:issue:attachment counts $restored_counts and retrievable attachment objects"
