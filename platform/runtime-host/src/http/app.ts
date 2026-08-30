import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { DispatchFunc, InjectOptions, Response as InjectResponse } from "light-my-request";
import { MAX_AGENT_REQUEST_BYTES } from "@sre/agent-protocol";
import { renderMetrics } from "@sre/telemetry";
import type { ApiDependencies } from "../bootstrap/dependencies.ts";
import { managementRouter } from "../management/routes.ts";
import { registerManagerRoutes } from "./manager.ts";
import { oidcAuthenticationMiddleware } from "./oidc.ts";
import { registerSpecialistRoutes } from "./specialist.ts";

/** Express app augmented with a socketless request injector for tests/dev harness. */
export type TestableApp = Express & {
  inject(options: InjectOptions | string): Promise<InjectResponse>;
  close(): Promise<void>;
};

export function createApp(deps: ApiDependencies): TestableApp {
  const bodyLimit = deps.mode === "specialist" ? MAX_AGENT_REQUEST_BYTES : 64 * 1024;
  const app = express();
  app.disable("x-powered-by");
  app.use((request: Request, _response: Response, next: NextFunction) => { request.requestId = randomUUID(); next(); });
  app.use(express.json({ limit: bodyLimit }));

  app.get("/health/live", (_request, response) => { response.json({ status: "ok", mode: deps.mode, agentId: deps.agent.name }); });
  app.get("/health/ready", (_request, response) => {
    response.json({ status: "ready", mode: deps.mode, agentId: deps.agent.name, configRevision: "real-poc-1", environmentMode: deps.config.env, dependencyModes: deps.config.clients });
  });
  app.get("/metrics", (_request, response) => { response.type("text/plain; version=0.0.4").send(renderMetrics()); });
  if (deps.mode === "manager" && deps.delegationPublicJwk) {
    app.get("/internal/.well-known/jwks.json", (_request, response) => { response.json({ keys: [deps.delegationPublicJwk] }); });
  }

  if (deps.mode === "manager") {
    registerManagerRoutes(app, deps);
    // read-only management plane, behind the same human authentication as /v1/query.
    // `state` is a FUNCTION: it is evaluated per request, so an Agent merged a
    // moment ago is listed without this process being restarted.
    app.use("/management", oidcAuthenticationMiddleware(deps.oidc), managementRouter({
      /*
       * `catalog` is deps.registry — the EFFECTIVE catalog, the very object the
       * orchestrator routes from, not the raw desired-state catalog inside the
       * snapshot. Handing over the raw one would reintroduce the divergence
       * this work removed: the console would call an Agent routable on desired
       * state alone while the router had already dropped it as unavailable.
       */
      state: () => {
        const snapshot = deps.desiredState.current();
        return { ...snapshot, catalog: deps.registry, enabledAgentIds: deps.registry.listEnabled().map((entry) => entry.agentId) };
      },
      config: deps.config,
      runs: deps.runs,
      ...(deps.promptAssistModel ? { promptAssistModel: deps.promptAssistModel } : {}),
      ...(deps.argo ? { argo: deps.argo } : {}),
      ...(deps.runtimeProbe ? { runtimeProbe: deps.runtimeProbe } : {}),
    }));
  } else registerSpecialistRoutes(app, deps);

  // body-parse errors (malformed JSON / oversized) mapped to the per-mode shape
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const tooLarge = typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large";
    if (deps.mode === "specialist") {
      response.status(tooLarge ? 413 : 400).json({ code: tooLarge ? "AGENT_REQUEST_TOO_LARGE" : "AGENT_INVALID_RESPONSE", message: "Invalid agent request" });
      return;
    }
    response.status(tooLarge ? 413 : 400).json({ requestId: request.requestId, code: "MCP_INVALID_CALL", message: "Invalid request body" });
  });

  return attachInject(app);
}

function attachInject(app: Express): TestableApp {
  const testable = app as TestableApp;
  // light-my-request is a dev/test-only dependency; load it lazily so the
  // production image (npm ci --omit=dev) never needs it.
  testable.inject = async (options) => {
    const { inject } = await import("light-my-request");
    return inject(app as unknown as DispatchFunc, typeof options === "string" ? { url: options } : options);
  };
  testable.close = async () => {};
  return testable;
}

