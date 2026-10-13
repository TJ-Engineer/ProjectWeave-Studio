import { closePool } from "./client";
import { processNotificationOutboxBatch } from "./repository";

let stopping = false;

process.once("SIGTERM", () => {
  stopping = true;
});
process.once("SIGINT", () => {
  stopping = true;
});

async function run(): Promise<void> {
  const pollMilliseconds = Math.max(
    100,
    Number(process.env.NOTIFICATION_POLL_MS ?? "1000"),
  );
  while (!stopping) {
    const result = await processNotificationOutboxBatch(50);
    if (result.failed > 0 || result.delivered > 0 || result.suppressed > 0) {
      console.log(
        JSON.stringify({ event: "notification.delivery", ...result }),
      );
    }
    if (result.processed === 0) {
      await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
    }
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
