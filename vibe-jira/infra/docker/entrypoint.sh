#!/bin/sh
set -eu

case "${1:-web}" in
  web)
    cd /app/apps/web
    exec node ../../node_modules/next/dist/bin/next start
    ;;
  dev)
    cd /app/apps/web
    exec node ../../node_modules/next/dist/bin/next dev
    ;;
  migrate)
    exec node --import tsx packages/database/src/migrate.ts
    ;;
  seed)
    exec node --import tsx packages/database/src/seed.ts
    ;;
  notification-worker)
    exec node --import tsx packages/database/src/notification-worker.ts
    ;;
  outbox-worker)
    exec node --import tsx packages/database/src/outbox-worker.ts
    ;;
  outbox-health)
    exec node --import tsx packages/database/src/outbox-worker-health.ts
    ;;
  recovery-verify)
    exec node --import tsx packages/database/src/recovery-verify.ts
    ;;
  *)
    echo "Unknown Vibe JIRA process: $1" >&2
    exit 64
    ;;
esac
