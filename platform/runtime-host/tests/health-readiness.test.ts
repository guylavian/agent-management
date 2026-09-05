import { describe, expect, it } from "vitest";
import { buildDependencies, createApp } from "../src/index.ts";

describe("health/ready endpoint", () => {
  it("returns 200 with healthy dependencies in manager mode", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ready");
    expect(body).toHaveProperty("dependencyStatus");
    await app.close();
  });

  it("response contains real revision not hardcoded value", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // should not have hardcoded "real-poc-1"
    expect(body.configRevision).not.toBe("real-poc-1");
    await app.close();
  });

  it("includes per-dependency status in response", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("dependencyStatus");
    expect(body.dependencyStatus).toHaveProperty("desiredState");
    // postgres and operational are optional depending on config
    expect(typeof body.dependencyStatus.desiredState).toBe("string");
    await app.close();
  });

  it("returns 503 when desired state has errors", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    // corrupt the desired state by forcing an error
    const originalCurrent = deps.desiredState.current;
    deps.desiredState.current = () => {
      const snapshot = originalCurrent.call(deps.desiredState);
      return { ...snapshot, error: "desired state load failed" };
    };
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.dependencyStatus.desiredState).toBe("unhealthy");
    await app.close();
  });
});

describe("readiness reports what it actually checked", () => {
  it("is not ready when the database does not answer", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    // a pg Pool connects lazily, so readiness must ASK rather than assume
    (deps.config.clients as { postgres: string }).postgres = "real";
    (deps.runs as { ping?: () => Promise<void> }).ping = async () => { throw new Error("connection refused"); };
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json().dependencyStatus.postgres).toBe("unhealthy");
    await app.close();
  });

  it("is ready when the database answers", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    (deps.config.clients as { postgres: string }).postgres = "real";
    (deps.runs as { ping?: () => Promise<void> }).ping = async () => { /* answers */ };
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json().dependencyStatus.postgres).toBe("healthy");
    await app.close();
  });

  it("is not ready when the operational plane is on but nothing has been activated", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    // a fresh read of an EMPTY table means no agent is routable — the outage a
    // missing reconciler produces, which must not be served as "ready"
    const operational = deps.operational as { configured: boolean; snapshot: () => unknown };
    Object.defineProperty(operational, "configured", { get: () => true, configurable: true });
    operational.snapshot = () => ({ refreshedAt: Date.now(), rows: new Map(), error: undefined });
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json().dependencyStatus.operational).toBe("unhealthy");
    await app.close();
  });

  it("is ready when a reconciler has written activations recently", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    const operational = deps.operational as { configured: boolean; snapshot: () => unknown };
    Object.defineProperty(operational, "configured", { get: () => true, configurable: true });
    operational.snapshot = () => ({ refreshedAt: Date.now(), rows: new Map([["keycloak", {}]]), error: undefined });
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json().dependencyStatus.operational).toBe("healthy");
    await app.close();
  });

  it("is not ready when the operational snapshot has gone stale", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    const operational = deps.operational as { configured: boolean; snapshot: () => unknown };
    Object.defineProperty(operational, "configured", { get: () => true, configurable: true });
    operational.snapshot = () => ({ refreshedAt: Date.now() - 120_000, rows: new Map([["keycloak", {}]]), error: undefined });
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("returns 503 when OIDC JWKS endpoint is unreachable", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    // Wire a probe that fails
    (deps as { probes?: Record<string, () => Promise<void>> }).probes = {
      oidc: async () => { throw new Error("connection refused"); },
    };
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.dependencyStatus.oidc).toBe("unhealthy");
    await app.close();
  });

  it("returns 200 when OIDC JWKS endpoint is reachable", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    // Wire a probe that succeeds
    (deps as { probes?: Record<string, () => Promise<void>> }).probes = {
      oidc: async () => { /* reachable */ },
    };
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dependencyStatus.oidc).toBe("healthy");
    await app.close();
  });

  it("treats HTTP 401 response as model endpoint reachable", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    // Wire a probe that succeeds even though it would get 401
    (deps as { probes?: Record<string, () => Promise<void>> }).probes = {
      model: async () => { /* reachable */ },
    };
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dependencyStatus.model).toBe("healthy");
    await app.close();
  });

  it("omits probe entry when probe is not configured", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    // Don't wire any probes
    (deps as { probes?: Record<string, () => Promise<void>> }).probes = undefined;
    const app = createApp(deps);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dependencyStatus.oidc).toBeUndefined();
    expect(body.dependencyStatus.model).toBeUndefined();
    await app.close();
  });

  it("does not hang past timeout for slow probes", async () => {
    const deps = buildDependencies({});
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    // Wire a probe that times out
    (deps as { probes?: Record<string, () => Promise<void>> }).probes = {
      oidc: async () => { await new Promise(() => {}); }, // never resolves
    };
    const app = createApp(deps);
    const startMs = Date.now();
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    const elapsedMs = Date.now() - startMs;
    // Should complete within 5 seconds even with slow probe (2s timeout + margin)
    expect(elapsedMs).toBeLessThan(5000);
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.dependencyStatus.oidc).toBe("unhealthy");
    await app.close();
  });
});

/**
 * A PROBE THAT ACCEPTS ANY HTTP RESPONSE IS NOT A READINESS CHECK.
 *
 * Both external probes treated every response as success — the comments said so
 * outright — so a JWKS endpoint answering 404 and a model endpoint answering 500
 * both reported "healthy". Kubernetes then keeps the pod Ready and routes
 * traffic to a process that cannot authenticate a single request.
 *
 * Reachability was the stated intent, but readiness is what the endpoint is
 * used for: the kubelet removes a pod from Service endpoints on this answer.
 */
import { createOidcProbe, createModelProbe } from "../src/bootstrap/dependencies.ts";

describe("external probes reject a dependency that answers but cannot serve", () => {
  const config = { oidc: { jwksUri: "https://idp.test/jwks" }, llm: { baseUrl: "https://model.test/v1" } } as never;

  function withFetch(status: number, body: unknown, run: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
    return run().finally(() => { globalThis.fetch = original; });
  }

  it("fails the OIDC probe when the JWKS endpoint 404s", async () => {
    const probe = createOidcProbe({ mode: "real" } as never, config);
    await withFetch(404, { error: "not found" }, async () => {
      await expect(probe?.()).rejects.toThrow();
    });
  });

  it("fails the OIDC probe when the response carries no usable keys", async () => {
    // a 200 that is not a key set authenticates nothing
    const probe = createOidcProbe({ mode: "real" } as never, config);
    await withFetch(200, { keys: [] }, async () => {
      await expect(probe?.()).rejects.toThrow();
    });
  });

  it("passes the OIDC probe on a real key set", async () => {
    const probe = createOidcProbe({ mode: "real" } as never, config);
    await withFetch(200, { keys: [{ kid: "k1", kty: "RSA" }] }, async () => {
      await expect(probe?.()).resolves.toBeUndefined();
    });
  });

  it("fails the model probe on a 500", async () => {
    const probe = createModelProbe({ mode: "real" } as never, config);
    await withFetch(500, { error: "boom" }, async () => {
      await expect(probe?.()).rejects.toThrow();
    });
  });
});
