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
