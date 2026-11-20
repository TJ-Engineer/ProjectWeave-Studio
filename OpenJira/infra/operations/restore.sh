#!/bin/sh
set -eu

backup_dir=${1:?Usage: CONFIRM_RESTORE=RESTORE restore.sh BACKUP_DIRECTORY}
if [ "${CONFIRM_RESTORE:-}" != "RESTORE" ]; then
  echo "Set CONFIRM_RESTORE=RESTORE to acknowledge that database contents will be replaced." >&2
  exit 64
fi
if [ ! -f "$backup_dir/database.dump" ] || [ ! -f "$backup_dir/object-storage.tar" ]; then
  echo "Backup directory is incomplete: $backup_dir" >&2
  exit 66
fi

(cd "$backup_dir" && sed -n '/^[0-9a-f]\{64\}/p' manifest.txt | shasum -a 256 -c -)

docker compose stop app notification-worker outbox-worker object-storage >/dev/null 2>&1 || true
docker compose exec -T postgres pg_restore \
  --username "${POSTGRES_USER:-vibe}" \
  --dbname "${POSTGRES_DB:-vibe_jira}" \
  --clean --if-exists --no-owner --no-privileges < "$backup_dir/database.dump"
docker compose run --rm --no-deps --entrypoint sh object-storage \
  -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
docker compose run --rm --no-deps --entrypoint tar object-storage \
  -C /data -xf - \
  < "$backup_dir/object-storage.tar"

docker compose up -d object-storage
docker compose run --rm migrate
docker compose up -d app notification-worker outbox-worker
echo "Restore completed; verify readiness, record counts, attachments, and audit history."
