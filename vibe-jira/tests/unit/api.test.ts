import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@vibe/domain";
import { handleApiError, requireIdempotency } from "../../apps/web/lib/api";

vi.mock("../../apps/web/lib/session", () => ({ currentIdentity: vi.fn() }));

describe("API hardening helpers", () => {
  it("requires a valid idempotency key and hashes canonical input", () => {
    const withoutKey = new Request("http://localhost/api/v1/projects");
    expect(() => requireIdempotency(withoutKey, {})).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        status: 400,
      }),
    );

    const invalidKey = new Request("http://localhost/api/v1/projects", {
      headers: { "idempotency-key": "short" },
    });
    expect(() => requireIdempotency(invalidKey, {})).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "INVALID_IDEMPOTENCY_KEY",
        status: 400,
      }),
    );

    const request = new Request("http://localhost/api/v1/projects", {
      headers: { "idempotency-key": "request-12345678" },
    });
    expect(
      requireIdempotency(request, { name: "Project", key: "PRJ" }),
    ).toEqual(requireIdempotency(request, { key: "PRJ", name: "Project" }));
  });

  it("returns stable domain and database error envelopes", async () => {
    const forbidden = handleApiError(
      new DomainError("FORBIDDEN", "Not allowed", 403),
      "correlation-123",
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Not allowed",
        correlationId: "correlation-123",
      },
    });

    const duplicate = handleApiError(
      {
        code: "23505",
        constraint: "projects_organization_id_project_key_key",
      },
      "correlation-456",
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: {
        code: "PROJECT_KEY_TAKEN",
        message: "That project key is already in use",
        correlationId: "correlation-456",
      },
    });
  });
});
