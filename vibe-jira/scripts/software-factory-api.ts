import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type FactoryService = "jira" | "openrm";

interface Environment {
  [name: string]: string | undefined;
}

export interface FactoryRequestOptions {
  service: FactoryService;
  method: string;
  path: string;
  data?: unknown;
  idempotencyKey?: string;
}

export interface FactoryResponse {
  service: FactoryService;
  status: number;
  ok: boolean;
  correlationId: string;
  body: unknown;
}

interface ServiceConfiguration {
  baseUrl: URL;
  headers: Record<string, string>;
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secureApiOrigin(value: string, variableName: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `${variableName} must be an HTTPS origin (or loopback HTTP) without credentials`,
    );
  }
  if (url.search || url.hash) {
    throw new Error(`${variableName} cannot contain a query or fragment`);
  }
  if (url.pathname !== "/") {
    throw new Error(`${variableName} must be an origin without a path`);
  }
  return url;
}

export function serviceConfiguration(
  service: FactoryService,
  environment: Environment = process.env,
): ServiceConfiguration {
  if (service === "jira") {
    return {
      baseUrl: secureApiOrigin(
        environment.PROJECTWEAVE_API_BASE_URL ?? "http://127.0.0.1:3000",
        "PROJECTWEAVE_API_BASE_URL",
      ),
      headers: {
        authorization: `Bearer ${required(environment, "PROJECTWEAVE_API_TOKEN")}`,
      },
    };
  }
  return {
    baseUrl: secureApiOrigin(
      environment.OPENRM_API_BASE_URL ?? "http://127.0.0.1:8080",
      "OPENRM_API_BASE_URL",
    ),
    headers: {
      authorization: `Bearer ${required(environment, "OPENRM_API_TOKEN")}`,
      "x-openrm-organization": required(environment, "OPENRM_ORGANIZATION_ID"),
    },
  };
}

export function resolveApiUrl(baseUrl: URL, path: string): URL {
  if (!path.startsWith("/api/v1/") || path.includes("\\")) {
    throw new Error("API paths must start with /api/v1/");
  }
  const url = new URL(path, baseUrl.origin);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/api/v1/")) {
    throw new Error("API path escaped the configured service origin");
  }
  return url;
}

export async function factoryRequest(
  options: FactoryRequestOptions,
  environment: Environment = process.env,
): Promise<FactoryResponse> {
  const configuration = serviceConfiguration(options.service, environment);
  const url = resolveApiUrl(configuration.baseUrl, options.path);
  const correlationId = randomUUID();
  const method = options.method.trim().toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
    throw new Error("Method must be GET, POST, PUT, PATCH, or DELETE");
  }
  if (method === "GET" && options.data !== undefined) {
    throw new Error("GET requests cannot include JSON data");
  }
  const headers = new Headers({
    accept: "application/json",
    ...configuration.headers,
  });
  headers.set(
    options.service === "openrm" ? "x-request-id" : "x-correlation-id",
    correlationId,
  );
  if (options.data !== undefined)
    headers.set("content-type", "application/json");
  if (options.idempotencyKey) {
    headers.set(
      options.service === "openrm" ? "x-idempotency-key" : "idempotency-key",
      options.idempotencyKey,
    );
  } else if (method === "POST") {
    headers.set(
      options.service === "openrm" ? "x-idempotency-key" : "idempotency-key",
      `agent:${randomUUID()}`,
    );
  }
  const response = await fetch(url, {
    method,
    headers,
    ...(options.data === undefined
      ? {}
      : { body: JSON.stringify(options.data) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (text.length > 5_000_000) {
    throw new Error("API response exceeded the 5 MB agent-client limit");
  }
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return {
    service: options.service,
    status: response.status,
    ok: response.ok,
    correlationId:
      response.headers.get("x-correlation-id") ??
      response.headers.get("x-trace-id") ??
      response.headers.get("x-request-id") ??
      correlationId,
    body,
  };
}

const usageText = `Usage:
  npm run factory:api -- jira METHOD /api/v1/PATH [--data JSON | --data-file FILE] [--idempotency-key KEY]
  npm run factory:api -- openrm METHOD /api/v1/PATH [--data JSON | --data-file FILE] [--idempotency-key KEY]`;

function usage(): never {
  throw new Error(usageText);
}

async function commandOptions(
  values: string[],
): Promise<FactoryRequestOptions> {
  const service = values[0] as FactoryService | undefined;
  const method = values[1];
  const path = values[2];
  if (!service || !["jira", "openrm"].includes(service) || !method || !path)
    usage();
  let data: unknown;
  let idempotencyKey: string | undefined;
  for (let index = 3; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!value) usage();
    if (option === "--data") {
      if (data !== undefined)
        throw new Error("JSON data was supplied more than once");
      data = JSON.parse(value) as unknown;
    } else if (option === "--data-file") {
      if (data !== undefined)
        throw new Error("JSON data was supplied more than once");
      data = JSON.parse(await readFile(value, "utf8")) as unknown;
    } else if (option === "--idempotency-key") {
      idempotencyKey = value;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  return {
    service,
    method,
    path,
    ...(data === undefined ? {} : { data }),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

async function main(): Promise<void> {
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    process.stdout.write(`${usageText}\n`);
    return;
  }
  const result = await factoryRequest(
    await commandOptions(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
