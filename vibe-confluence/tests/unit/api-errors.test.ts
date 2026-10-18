import {
  createSpaceSchema,
  spaceKeySchema,
  spaceMemberPageQuerySchema,
  updatePageRestrictionSchema,
} from "@knowledge/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/web/lib/session", () => ({
  currentIdentity: vi.fn(),
}));

import {
  handleApiError,
  parsePositiveIntegerPath,
  parseUuidPath,
  requireIdempotencyKey,
} from "../../apps/web/lib/api";

describe("API error contract", () => {
  it("returns stable 422 validation responses", async () => {
    let validationError: unknown;
    try {
      createSpaceSchema.parse({ key: "1", name: "" });
    } catch (error) {
      validationError = error;
    }

    const response = handleApiError(validationError, "correlation-id");
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        fields: {
          key: expect.any(Array),
          name: expect.any(Array),
        },
      },
      correlationId: "correlation-id",
    });
  });

  it("validates UUID and positive-integer route parameters", () => {
    expect(() => parseUuidPath("not-a-uuid", "pageId")).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR", status: 422 }),
    );
    expect(() => parsePositiveIntegerPath("0", "number")).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR", status: 422 }),
    );
    expect(
      parseUuidPath("018f4f9e-37d8-7a1f-b465-87a8d5cdf11f", "pageId"),
    ).toBe("018f4f9e-37d8-7a1f-b465-87a8d5cdf11f");
    expect(parsePositiveIntegerPath("12", "number")).toBe(12);
  });

  it("normalizes valid space keys and rejects invalid route keys", () => {
    expect(spaceKeySchema.parse("secure1")).toBe("SECURE1");
    const response = handleApiError(
      spaceKeySchema.safeParse("1").error,
      "correlation-id",
    );
    expect(response.status).toBe(422);
  });

  it("treats malformed idempotency keys as invalid input", () => {
    const request = new Request("http://localhost/api", {
      headers: { "idempotency-key": "short" },
    });
    expect(() => requireIdempotencyKey(request)).toThrowError(
      expect.objectContaining({
        code: "INVALID_IDEMPOTENCY_KEY",
        status: 422,
      }),
    );
  });

  it("bounds administration queries and rejects ambiguous allowlists", () => {
    expect(
      spaceMemberPageQuerySchema.parse({
        kind: "candidates",
        query: "  admin  ",
        limit: "50",
      }),
    ).toEqual({
      kind: "candidates",
      query: "admin",
      cursor: null,
      limit: 50,
    });
    expect(() => spaceMemberPageQuerySchema.parse({ limit: "51" })).toThrow();
    const memberId = "018f4f9e-37d8-7a1f-b465-87a8d5cdf11f";
    expect(() =>
      updatePageRestrictionSchema.parse({
        restricted: true,
        memberIds: [memberId, memberId],
        expectedVersion: 1,
      }),
    ).toThrow();
    expect(() =>
      updatePageRestrictionSchema.parse({
        restricted: false,
        memberIds: [memberId],
        expectedVersion: 1,
      }),
    ).toThrow();
  });
});
