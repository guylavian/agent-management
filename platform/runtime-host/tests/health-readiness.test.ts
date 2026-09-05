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
});
