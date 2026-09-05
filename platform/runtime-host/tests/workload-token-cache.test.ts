import { describe, it, expect, vi } from "vitest";
import { ClientCredentialsWorkloadTokenProvider } from "../src/transport/http.ts";

// H-PERF2: Workload token caching
describe("H-PERF2: workload token cache", () => {
  it("performs one token fetch for multiple calls within token lifetime", async () => {
    let fetchCalls = 0;
    const mockFetch = vi.fn(async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ access_token: "a".repeat(40), expires_in: 60 }),
      } as any;
    });

    const provider = new ClientCredentialsWorkloadTokenProvider(
      {
        tokenEndpoint: "http://keycloak/token",
        clientId: "test-client",
        clientSecret: "secret",
      },
      mockFetch,
    );

    // First call - fetches token
    const token1 = await provider.getToken("sre-agent:keycloak");
    expect(fetchCalls).toBe(1);
    expect(token1).toBe("a".repeat(40));

    // Second call within lifetime - should use cached token
    const token2 = await provider.getToken("sre-agent:keycloak");
    expect(fetchCalls).toBe(1); // No additional fetch
    expect(token2).toBe("a".repeat(40));

    // Third call - still within lifetime
    const token3 = await provider.getToken("sre-agent:keycloak");
    expect(fetchCalls).toBe(1); // No additional fetch
    expect(token3).toBe("a".repeat(40));
  });

  it("fetches a new token when entering skew guard window", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    let tokenCount = 0;
    const mockFetch = vi.fn(async () => {
      tokenCount += 1;
      // Token expires in 10 seconds
      return {
        ok: true,
        json: async () => ({ access_token: ("a" + tokenCount).padEnd(40, "x"), expires_in: 10 }),
      } as any;
    });

    const provider = new ClientCredentialsWorkloadTokenProvider(
      {
        tokenEndpoint: "http://keycloak/token",
        clientId: "test-client",
        clientSecret: "secret",
      },
      mockFetch,
    );

    const token1 = await provider.getToken("sre-agent:keycloak");
    expect(token1).toMatch(/^a1/);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Move time forward but well before skew guard (10s - 5s = 5s remaining)
    vi.advanceTimersByTime(2000);
    const token2 = await provider.getToken("sre-agent:keycloak");
    expect(token2).toMatch(/^a1/); // Still cached, 8s remaining
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Move to exactly 5s before expiry (10s expiry - 5s = at 5s mark)
    vi.advanceTimersByTime(3100); // now at 5100ms, expiry at 10000ms
    const token3 = await provider.getToken("sre-agent:keycloak");
    expect(token3).toMatch(/^a2/); // Refreshed, within skew guard
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("respects the 5s skew guard", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    let fetchCalls = 0;
    const mockFetch = vi.fn(async () => {
      fetchCalls += 1;
      // Token expires in 60 seconds
      return {
        ok: true,
        json: async () => ({ access_token: ("token" + fetchCalls).padEnd(40, "x"), expires_in: 60 }),
      } as any;
    });

    const provider = new ClientCredentialsWorkloadTokenProvider(
      {
        tokenEndpoint: "http://keycloak/token",
        clientId: "test-client",
        clientSecret: "secret",
      },
      mockFetch,
    );

    const token1 = await provider.getToken("sre-agent:keycloak");
    expect(token1).toMatch(/^token1/);
    expect(fetchCalls).toBe(1);

    // Move time forward to 30s (plenty of time, 30s remaining)
    vi.advanceTimersByTime(30000);
    const token2 = await provider.getToken("sre-agent:keycloak");
    expect(token2).toMatch(/^token1/); // Still cached
    expect(fetchCalls).toBe(1);

    // Move to 56s (within 5s skew guard now, only 4s remaining)
    vi.advanceTimersByTime(26000);
    const token3 = await provider.getToken("sre-agent:keycloak");
    expect(token3).toMatch(/^token2/); // Refreshed due to skew guard
    expect(fetchCalls).toBe(2);

    vi.useRealTimers();
  });

  it("defaults to 60s expires_in when not provided", async () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    let fetchCalls = 0;
    const mockFetch = vi.fn(async () => {
      fetchCalls += 1;
      // No expires_in field - should default to 60
      return {
        ok: true,
        json: async () => ({ access_token: ("token" + fetchCalls).padEnd(40, "x") }),
      } as any;
    });

    const provider = new ClientCredentialsWorkloadTokenProvider(
      {
        tokenEndpoint: "http://keycloak/token",
        clientId: "test-client",
        clientSecret: "secret",
      },
      mockFetch,
    );

    const token1 = await provider.getToken("sre-agent:keycloak");
    expect(token1).toMatch(/^token1/);
    expect(fetchCalls).toBe(1);

    // Move 30 seconds forward - should still be cached (30s remaining)
    vi.advanceTimersByTime(30000);
    const token2 = await provider.getToken("sre-agent:keycloak");
    expect(token2).toMatch(/^token1/); // Still cached
    expect(fetchCalls).toBe(1);

    // Move to 56 seconds forward - still within lifetime (4s remaining, within skew)
    vi.advanceTimersByTime(26000);
    const token3 = await provider.getToken("sre-agent:keycloak");
    expect(token3).toMatch(/^token2/); // Refreshed within skew guard
    expect(fetchCalls).toBe(2);

    vi.useRealTimers();
  });

  it("different audiences have separate cache entries", async () => {
    let fetchCalls = 0;
    const mockFetch = vi.fn(async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ access_token: ("a" + fetchCalls).padEnd(40, "x"), expires_in: 60 }),
      } as any;
    });

    const provider = new ClientCredentialsWorkloadTokenProvider(
      {
        tokenEndpoint: "http://keycloak/token",
        clientId: "test-client",
        clientSecret: "secret",
      },
      mockFetch,
    );

    const token1 = await provider.getToken("sre-agent:keycloak");
    expect(token1).toMatch(/^a1/);
    expect(fetchCalls).toBe(1);

    const token2 = await provider.getToken("sre-agent:prometheus");
    expect(token2).toMatch(/^a2/);
    expect(fetchCalls).toBe(2);

    // Same audience as first call should use cached token
    const token3 = await provider.getToken("sre-agent:keycloak");
    expect(token3).toMatch(/^a1/);
    expect(fetchCalls).toBe(2); // No additional fetch
  });
});
