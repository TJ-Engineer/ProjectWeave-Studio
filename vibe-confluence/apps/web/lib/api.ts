import { randomUUID } from "node:crypto";
import type { ApiErrorBody, UserIdentity } from "@knowledge/contracts";
import { DomainError } from "@knowledge/domain";
import { NextResponse } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { currentIdentity } from "./session";

export function correlationId(request: Request): string {
  const candidate = request.headers.get("x-correlation-id");
  return candidate && /^[A-Za-z0-9_-]{8,100}$/.test(candidate)
    ? candidate
    : randomUUID();
}

export async function requireIdentity(): Promise<UserIdentity> {
  const identity = await currentIdentity();
  if (!identity)
    throw new DomainError("UNAUTHENTICATED", "Sign in to continue", 401);
  return identity;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const host =
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
    (originHost && host && originHost !== host)
  ) {
    throw new DomainError(
      "INVALID_ORIGIN",
      "Cross-origin requests are not allowed",
      403,
    );
  }
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

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new DomainError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 8-128 safe characters",
      422,
    );
  }
  return key;
}

export function parseUuidPath(value: string, field: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `${field} must be a valid UUID`,
      422,
    );
  }
  return parsed.data;
}

export function parsePositiveIntegerPath(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `${field} must be a positive integer`,
      422,
    );
  }
  return parsed;
}

export function handleApiError(
  error: unknown,
  id: string,
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
    status = 422;
    code = "VALIDATION_ERROR";
    message = "The request contains invalid values";
    fields = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "request";
      (fields[key] ??= []).push(issue.message);
    }
  } else if (isPostgresError(error) && error.code === "23505") {
    status = 409;
    code = "CONFLICT";
    message = "A record with that value already exists";
  } else {
    console.error(
      JSON.stringify({ level: "error", event: "api.error", correlationId: id }),
    );
  }
  return NextResponse.json(
    {
      error: { code, message, ...(fields ? { fields } : {}) },
      correlationId: id,
    },
    { status, headers: { "x-correlation-id": id } },
  );
}

function isPostgresError(error: unknown): error is { code: string } {
  return Boolean(error && typeof error === "object" && "code" in error);
}
