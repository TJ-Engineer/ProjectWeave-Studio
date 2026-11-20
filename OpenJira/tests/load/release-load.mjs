/* eslint-disable no-undef */
import process from "node:process";

const baseUrl = (process.env.LOAD_BASE_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? "10");
const iterations = Number(process.env.LOAD_ITERATIONS ?? "40");

async function request(path, init = {}) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, init);
  const duration = performance.now() - started;
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} returned ${response.status}`,
    );
  }
  return { response, duration };
}

const login = await request("/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json", origin: baseUrl },
  body: JSON.stringify({
    email: process.env.LOAD_EMAIL ?? "admin@vibe.local",
    password: process.env.LOAD_PASSWORD ?? "vibe-development-only",
  }),
});
const cookie = login.response.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Login did not return a session cookie");
const headers = { cookie };
const projectsResponse = await request("/api/v1/projects?limit=1", { headers });
const projects = await projectsResponse.response.json();
const project = projects.items?.[0];
if (!project) throw new Error("The load target has no project");

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

async function runBounded(work) {
  const values = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < iterations) {
        next += 1;
        values.push(await work());
      }
    }),
  );
  return values;
}

const board = await runBounded(async () => {
  const result = await request(
    `/api/v1/boards/${project.boardId}/issues?limit=50`,
    { headers },
  );
  await result.response.arrayBuffer();
  return result.duration;
});
const search = await runBounded(async () => {
  const result = await request("/api/v1/search/issues?q=release&limit=20", {
    headers,
  });
  await result.response.arrayBuffer();
  return result.duration;
});
const csv = [
  "Summary,Description,Issue Type,Priority,Labels",
  ...Array.from(
    { length: 100 },
    (_, index) => `Load dry run ${index},Generated,Task,MEDIUM,load`,
  ),
].join("\n");
const imports = await runBounded(async () => {
  const result = await request(
    `/api/v1/projects/${project.key}/data-jobs/import/dry-run`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify({ csv }),
    },
  );
  await result.response.arrayBuffer();
  return result.duration;
});

const realtime = await Promise.all(
  Array.from({ length: Math.min(20, concurrency * 2) }, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    try {
      const result = await request(`/api/v1/boards/${project.boardId}/events`, {
        headers,
        signal: controller.signal,
      });
      return result.duration;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }),
);

const results = {
  concurrency,
  iterations,
  p95Ms: {
    board: percentile(board, 0.95),
    search: percentile(search, 0.95),
    importDryRun: percentile(imports, 0.95),
    realtimeConnect: percentile(realtime, 0.95),
  },
};
console.log(JSON.stringify(results, null, 2));
const budgets = {
  board: Number(process.env.LOAD_BOARD_P95_MS ?? "500"),
  search: Number(process.env.LOAD_SEARCH_P95_MS ?? "500"),
  importDryRun: Number(process.env.LOAD_IMPORT_P95_MS ?? "1000"),
  realtimeConnect: Number(process.env.LOAD_REALTIME_P95_MS ?? "1000"),
};
for (const [path, budget] of Object.entries(budgets)) {
  if (results.p95Ms[path] > budget) {
    console.error(
      `${path} p95 ${results.p95Ms[path].toFixed(1)} ms exceeds ${budget} ms`,
    );
    process.exitCode = 1;
  }
}
