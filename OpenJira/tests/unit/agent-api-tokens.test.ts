import { describe, expect, it } from "vitest";
import {
  agentApiTokenFromAuthorization,
  generateAgentApiToken,
  hashAgentApiToken,
  isAgentApiToken,
} from "@vibe/database";

describe("agent API token primitives", () => {
  it("generates bounded random bearer credentials and stores stable digests", () => {
    const first = generateAgentApiToken();
    const second = generateAgentApiToken();
    expect(first).toMatch(/^vibe_agent_[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(isAgentApiToken(first)).toBe(true);
    expect(hashAgentApiToken(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentApiToken(first)).toBe(hashAgentApiToken(first));
    expect(hashAgentApiToken(first)).not.toBe(hashAgentApiToken(second));
  });

  it("accepts only one well-formed bearer credential", () => {
    const token = generateAgentApiToken();
    expect(agentApiTokenFromAuthorization(`Bearer ${token}`)).toBe(token);
    expect(agentApiTokenFromAuthorization(`bearer ${token}`)).toBe(token);
    expect(agentApiTokenFromAuthorization(`Basic ${token}`)).toBeNull();
    expect(agentApiTokenFromAuthorization(`Bearer ${token} extra`)).toBeNull();
    expect(agentApiTokenFromAuthorization("Bearer malformed")).toBeNull();
  });
});
