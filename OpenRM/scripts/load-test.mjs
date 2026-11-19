/* global process, performance, fetch, AbortSignal */
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const baseUrl = args.get("--base-url") || process.env.OPENRM_LOAD_BASE_URL || "http://127.0.0.1:8080";
const requestLimit = Number(args.get("--requests") || 500);
const concurrency = Number(args.get("--concurrency") || 20);
const durationSeconds = Number(args.get("--duration") || 0);
const p95Limit = Number(args.get("--p95") || 250);
const errorRateLimit = Number(args.get("--error-rate") || 0.01);
const deadline = durationSeconds > 0 ? Date.now() + durationSeconds * 1000 : Number.POSITIVE_INFINITY;
const latencies = [];
let issued = 0;
let errors = 0;

async function worker() {
  while (issued < requestLimit && Date.now() < deadline) {
    issued += 1;
    const start = performance.now();
    try {
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) errors += 1;
      await response.arrayBuffer();
    } catch {
      errors += 1;
    }
    latencies.push(performance.now() - start);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
latencies.sort((left, right) => left - right);
const p95 = latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] || 0;
const errorRate = issued === 0 ? 1 : errors / issued;
const summary = { baseUrl, issued, concurrency, durationSeconds, errors, errorRate, p95Ms: p95 };
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (issued === 0 || errorRate > errorRateLimit || p95 > p95Limit) process.exit(1);
