import { afterEach, describe, expect, it, vi } from "vitest";
import {
  factoryRequest,
  resolveApiUrl,
  serviceConfiguration,
} from "../../scripts/software-factory-api";

afterEach(() => vi.unstubAllGlobals());

describe("software-factory REST client", () => {
  it("constructs scoped headers for each service", () => {
    const jira = serviceConfiguration("jira", {
      PROJECTWEAVE_API_TOKEN: "jira-secret",
    });
    expect(jira.baseUrl.origin).toBe("http://127.0.0.1:3000");
    expect(jira.headers).toEqual({ authorization: "Bearer jira-secret" });

    const openrm = serviceConfiguration("openrm", {
      OPENRM_API_TOKEN: "openrm-secret",
      OPENRM_ORGANIZATION_ID: "00000000-0000-4000-8000-000000000001",
    });
    expect(openrm.baseUrl.origin).toBe("http://127.0.0.1:8080");
    expect(openrm.headers).toMatchObject({
      authorization: "Bearer openrm-secret",
      "x-openrm-organization": "00000000-0000-4000-8000-000000000001",
    });
  });

  it("keeps requests on a configured API origin", () => {
    const base = new URL("https://jira.example.test");
    expect(resolveApiUrl(base, "/api/v1/projects").href).toBe(
      "https://jira.example.test/api/v1/projects",
    );
    expect(() =>
      resolveApiUrl(base, "https://attacker.test/api/v1/projects"),
    ).toThrow("API paths must start with /api/v1/");
    expect(() => resolveApiUrl(base, "/health/ready")).toThrow(
      "API paths must start with /api/v1/",
    );
  });

  it("requires TLS away from loopback", () => {
    expect(() =>
      serviceConfiguration("jira", {
        PROJECTWEAVE_API_BASE_URL: "http://jira.example.test",
        PROJECTWEAVE_API_TOKEN: "secret",
      }),
    ).toThrow("must be an HTTPS origin");
  });

  it("uses each API's correlation and idempotency header contract", async () => {
    const requestHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        requestHeaders.push(init.headers as Headers);
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "x-request-id": "openrm-request-123" },
        });
      }),
    );
    const response = await factoryRequest(
      {
        service: "openrm",
        method: "POST",
        path: "/api/v1/projects",
        data: { name: "Factory" },
        idempotencyKey: "agent:test:project-create",
      },
      {
        OPENRM_API_TOKEN: "openrm-secret",
        OPENRM_ORGANIZATION_ID: "00000000-0000-4000-8000-000000000001",
      },
    );
    expect(requestHeaders[0]?.get("authorization")).toBe(
      "Bearer openrm-secret",
    );
    expect(requestHeaders[0]?.get("x-openrm-organization")).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(requestHeaders[0]?.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestHeaders[0]?.get("x-idempotency-key")).toBe(
      "agent:test:project-create",
    );
    expect(requestHeaders[0]?.has("idempotency-key")).toBe(false);
    expect(response.correlationId).toBe("openrm-request-123");
  });
});
