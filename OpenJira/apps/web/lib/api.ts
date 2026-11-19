import { createHash, randomUUID } from "node:crypto";
import type { ApiErrorBody, UserIdentity } from "@vibe/contracts";
import { consumeRateLimit } from "@vibe/database";
import { DomainError } from "@vibe/domain";
import { structuredLog } from "@vibe/observability";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { currentIdentity } from "./session";

export function correlationId(request: Request): string {
  const candidate =
    request.headers.get("x-correlation-id") ??
    request.headers.get("x-trace-id");
  return candidate && /^[a-zA-Z0-9_-]{8,100}$/.test(candidate)
    ? candidate
    : randomUUID();
}

export async function requireIdentity(): Promise<UserIdentity> {
  const identity = await currentIdentity();
  if (!identity)
    throw new DomainError("UNAUTHENTICATED", "Sign in to continue", 401);
  return identity;
}

export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T> {
  assertSameOrigin(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new DomainError(
      "INVALID_JSON",
      "Request body must be valid JSON",
      400,
    );
  }
  return schema.parse(body);
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const requestHost =
    process.env.TRUST_PROXY === "true"
      ? (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))
      : request.headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    throw new DomainError(
      "INVALID_ORIGIN",
      "The request origin is invalid",
      403,
    );
  }
  if (
    (fetchSite && !["same-origin", "none"].includes(fetchSite)) ||
    (originHost && requestHost && originHost !== requestHost)
  ) {
    throw new DomainError(
      "INVALID_ORIGIN",
      "Cross-origin requests are not allowed",
      403,
    );
  }
}

export async function enforceRateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowSeconds: number,
  discriminator: string,
): Promise<void> {
  const forwarded =
    process.env.TRUST_PROXY === "true"
      ? (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        request.headers.get("x-real-ip") ??
        "proxy-unknown")
      : "direct";
  const keyHash = createHash("sha256")
    .update(`${forwarded}:${discriminator.toLocaleLowerCase()}`)
    .digest("hex");
  const result = await consumeRateLimit(scope, keyHash, limit, windowSeconds);
  if (!result.allowed) {
    throw new DomainError(
      "RATE_LIMITED",
      `Too many requests. Try again in ${result.retryAfterSeconds} seconds`,
      429,
    );
  }
}

export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams));
}

export interface IdempotencyRequest {
  key: string;
  requestHash: string;
}

export function requireIdempotency(
  request: Request,
  input: unknown,
): IdempotencyRequest {
  const key = request.headers.get("idempotency-key");
  if (!key) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key header is required",
      400,
    );
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new DomainError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 8-128 letters, numbers, dots, underscores, colons, or hyphens",
      400,
    );
  }
  return {
    key,
    requestHash: createHash("sha256").update(stableJson(input)).digest("hex"),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function handleApiError(
  error: unknown,
  requestCorrelationId: string,
): NextResponse<ApiErrorBody> {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "An unexpected error occurred";
  let fields: Record<string, string[]> | undefined;

  if (error instanceof DomainError) {
    status = error.status;
    code = error.code;
    message = error.message;
  } else if (error instanceof ZodError) {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "The request contains invalid values";
    fields = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "request";
      (fields[key] ??= []).push(issue.message);
    }
  } else if (isPostgresError(error) && error.code === "23505") {
    status = 409;
    if (error.constraint === "projects_organization_id_project_key_key") {
      code = "PROJECT_KEY_TAKEN";
      message = "That project key is already in use";
    } else {
      code = "CONFLICT";
      message = "A record with that value already exists";
    }
  } else {
    structuredLog("error", "api.unhandled_error", {
      correlationId: requestCorrelationId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  const body: ApiErrorBody = {
    error: {
      code,
      message,
      correlationId: requestCorrelationId,
      ...(fields ? { fields } : {}),
    },
  };
  return NextResponse.json(body, {
    status,
    headers: { "x-correlation-id": requestCorrelationId },
  });
}

function isPostgresError(
  error: unknown,
): error is { code: string; constraint?: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
