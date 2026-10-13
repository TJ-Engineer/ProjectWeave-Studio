import { databasePoolMetrics, getPool } from "@vibe/database";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const configuredToken = process.env.METRICS_TOKEN;
  if (
    configuredToken &&
    request.headers.get("authorization") !== `Bearer ${configuredToken}`
  ) {
    return new NextResponse("Unauthorized\n", { status: 401 });
  }
  const [outbox, jobs] = await Promise.all([
    getPool().query<{ pending: string; dead: string }>(
      `SELECT
         count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL) AS pending,
         count(*) FILTER (WHERE dead_lettered_at IS NOT NULL) AS dead
       FROM outbox_events`,
    ),
    getPool().query<{ queued: string; failed: string }>(
      `SELECT
         count(*) FILTER (WHERE state IN ('QUEUED', 'RUNNING')) AS queued,
         count(*) FILTER (WHERE state = 'FAILED') AS failed
       FROM data_jobs`,
    ),
  ]);
  const pool = databasePoolMetrics();
  const outboxRow = outbox.rows[0];
  const jobRow = jobs.rows[0];
  const lines = [
    "# TYPE vibe_database_pool_connections gauge",
    `vibe_database_pool_connections{state="total"} ${pool.total}`,
    `vibe_database_pool_connections{state="idle"} ${pool.idle}`,
    `vibe_database_pool_connections{state="waiting"} ${pool.waiting}`,
    "# TYPE vibe_outbox_events gauge",
    `vibe_outbox_events{state="pending"} ${outboxRow?.pending ?? 0}`,
    `vibe_outbox_events{state="dead_lettered"} ${outboxRow?.dead ?? 0}`,
    "# TYPE vibe_data_jobs gauge",
    `vibe_data_jobs{state="queued"} ${jobRow?.queued ?? 0}`,
    `vibe_data_jobs{state="failed"} ${jobRow?.failed ?? 0}`,
    "",
  ];
  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
