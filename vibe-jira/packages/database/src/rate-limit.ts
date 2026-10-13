import { getPool } from "./client";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function consumeRateLimit(
  scope: string,
  keyHash: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Rate-limit capacity must be a positive integer");
  }
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("Rate-limit window must be a positive integer");
  }
  const result = await getPool().query<{
    request_count: number;
    retry_after_seconds: number;
  }>(
    `INSERT INTO request_rate_limits
       (scope, key_hash, window_started_at, request_count)
     VALUES ($1, $2, clock_timestamp(), 1)
     ON CONFLICT (scope, key_hash) DO UPDATE SET
       window_started_at = CASE
         WHEN request_rate_limits.window_started_at <=
              clock_timestamp() - make_interval(secs => $3::integer)
           THEN clock_timestamp()
         ELSE request_rate_limits.window_started_at
       END,
       request_count = CASE
         WHEN request_rate_limits.window_started_at <=
              clock_timestamp() - make_interval(secs => $3::integer)
           THEN 1
         ELSE request_rate_limits.request_count + 1
       END
     RETURNING request_count,
       greatest(1, ceil(extract(epoch FROM
         (window_started_at + make_interval(secs => $3::integer) -
          clock_timestamp()))))::integer AS retry_after_seconds`,
    [scope, keyHash, windowSeconds],
  );
  const row = result.rows[0];
  const count = row?.request_count ?? limit + 1;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: row?.retry_after_seconds ?? windowSeconds,
  };
}
