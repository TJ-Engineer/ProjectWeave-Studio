import { closePool } from "./client";
import { outboxWorkerHealthy } from "./repository";

outboxWorkerHealthy(Number(process.env.OUTBOX_HEALTH_MAX_AGE_SECONDS ?? "120"))
  .then((healthy) => {
    if (!healthy) process.exitCode = 1;
  })
  .catch(() => {
    process.exitCode = 1;
  })
  .finally(closePool);
