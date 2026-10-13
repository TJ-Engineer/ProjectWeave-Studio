#!/bin/sh
set -eu

backup_dir=${1:?Usage: backup.sh BACKUP_DIRECTORY}
mkdir -p "$backup_dir"

running_services=$(docker compose ps --status running --services)
restart_services() {
  for service in object-storage app notification-worker outbox-worker; do
    if printf '%s\n' "$running_services" | grep -qx "$service"; then
      docker compose up -d "$service" >/dev/null
    fi
  done
}
trap restart_services EXIT INT TERM

docker compose stop app notification-worker outbox-worker >/dev/null 2>&1 || true
docker compose exec -T postgres pg_dump \
  --username "${POSTGRES_USER:-vibe}" \
  --dbname "${POSTGRES_DB:-vibe_jira}" \
  --format=custom > "$backup_dir/database.dump"

docker compose stop object-storage >/dev/null
docker compose run --rm --no-deps --entrypoint tar object-storage \
  -C /data -cf - . \
  > "$backup_dir/object-storage.tar"

{
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "app_version=${APP_VERSION:-unknown}"
  echo "app_revision=${APP_REVISION:-unknown}"
  (cd "$backup_dir" && shasum -a 256 database.dump object-storage.tar)
} > "$backup_dir/manifest.txt"

restart_services
trap - EXIT INT TERM
echo "Backup written to $backup_dir"
