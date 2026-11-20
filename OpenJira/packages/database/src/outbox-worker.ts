import { randomUUID } from "node:crypto";
import { closePool } from "./client";
import {
  processGeneralOutboxBatch,
  processDataJobBatch,
  pruneExpiredAuditEvents,
  recordWorkerHeartbeat,
} from "./repository";

const workerName = "outbox";
const instanceId = process.env.OUTBOX_WORKER_ID ?? randomUUID();
let stopping = false;
let lastRetentionSweep = 0;

process.once("SIGTERM", () => {
  stopping = true;
});
process.once("SIGINT", () => {
  stopping = true;
});

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run(): Promise<void> {
  const pollMilliseconds = Math.max(
    100,
    Number(process.env.OUTBOX_POLL_MS ?? "1000"),
  );
  const maxAttempts = Math.max(
    1,
    Number(process.env.OUTBOX_MAX_ATTEMPTS ?? "8"),
  );
  await recordWorkerHeartbeat(workerName, instanceId);
  while (!stopping) {
    try {
      if (Date.now() - lastRetentionSweep >= 60 * 60 * 1000) {
        const pruned = await pruneExpiredAuditEvents();
        lastRetentionSweep = Date.now();
        if (pruned > 0) {
          console.log(
            JSON.stringify({
              level: "info",
              event: "audit.retention_pruned",
              worker: workerName,
              instanceId,
              pruned,
            }),
          );
        }
      }
      const result = await processGeneralOutboxBatch(
        100,
        maxAttempts,
        "internal-ledger",
      );
      const jobs = await processDataJobBatch(5);
      await recordWorkerHeartbeat(workerName, instanceId);
      if (
        result.processed > 0 ||
        result.failed > 0 ||
        result.deadLettered > 0 ||
        jobs.processed > 0 ||
        jobs.failed > 0
      ) {
        console.log(
          JSON.stringify({
            level: result.failed > 0 ? "warn" : "info",
            event: "outbox.delivery",
            worker: workerName,
            instanceId,
            ...result,
            jobs,
          }),
        );
      }
      if (
        result.processed === 0 &&
        result.failed === 0 &&
        jobs.processed === 0 &&
        jobs.failed === 0
      ) {
        await pause(pollMilliseconds);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown outbox worker error";
      await recordWorkerHeartbeat(workerName, instanceId, message).catch(
        () => undefined,
      );
      console.error(
        JSON.stringify({
          level: "error",
          event: "outbox.worker_error",
          worker: workerName,
          instanceId,
          error: message,
        }),
      );
      await pause(pollMilliseconds);
    }
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
