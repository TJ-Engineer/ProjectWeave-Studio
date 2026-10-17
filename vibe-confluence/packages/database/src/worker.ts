import { closePool, getPool } from "./client";

async function runOnce(): Promise<number> {
  const result = await getPool().query<{ id: string }>(
    `WITH claimed AS (
       SELECT id FROM outbox_events
        WHERE processed_at IS NULL
        ORDER BY created_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox_events o
        SET processed_at = now(), attempts = attempts + 1
       FROM claimed
      WHERE o.id = claimed.id
     RETURNING o.id`,
  );
  return result.rowCount ?? 0;
}

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

async function run(): Promise<void> {
  do {
    const count = await runOnce();
    if (count > 0) console.log(`Processed ${count} outbox event(s).`);
    if (process.env.WORKER_ONCE === "true") return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (!stopping);
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
