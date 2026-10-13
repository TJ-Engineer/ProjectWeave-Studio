import { describe, expect, it } from "vitest";
import { validateAttachment } from "@vibe/database";
import { DomainError } from "@vibe/domain";

describe("attachment validation", () => {
  it("normalizes safe names and verifies declared content", () => {
    const body = new TextEncoder().encode("plain text attachment");
    expect(
      validateAttachment("../evidence.txt", "text/plain; charset=utf-8", body),
    ).toEqual({
      filename: "evidence.txt",
      contentType: "text/plain",
      sizeBytes: body.byteLength,
    });
  });

  it("rejects unsupported or content-spoofed files", () => {
    expect(() =>
      validateAttachment(
        "payload.exe",
        "application/octet-stream",
        new Uint8Array([1]),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "ATTACHMENT_TYPE_NOT_ALLOWED",
        status: 422,
      }),
    );
    expect(() =>
      validateAttachment(
        "fake.png",
        "image/png",
        new TextEncoder().encode("not a png"),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "ATTACHMENT_CONTENT_MISMATCH",
        status: 422,
      }),
    );
  });

  it("enforces non-empty 10 MB bounds", () => {
    expect(() =>
      validateAttachment("empty.txt", "text/plain", new Uint8Array()),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "ATTACHMENT_SIZE_INVALID",
        status: 413,
      }),
    );
    expect(() =>
      validateAttachment(
        "large.txt",
        "text/plain",
        new Uint8Array(10 * 1024 * 1024 + 1),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "ATTACHMENT_SIZE_INVALID",
        status: 413,
      }),
    );
  });
});
