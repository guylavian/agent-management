import { MockAgentClient } from "@sre/agent-client";
import { loadAgentServiceRegistry } from "@sre/agent-registry";
import { MockDelegationAuthority } from "@sre/auth";
import { loadAgentInstance, type ManagerAgentConfig } from "@sre/config";
import { MockModelClient, type ModelClient } from "@sre/llm";
import type { RuntimeDependencies } from "../src/index.ts";

export const serviceRegistry = loadAgentServiceRegistry("agents/registry.yaml");
export const managerAgent = loadAgentInstance({ configFile: "agents/manager.yaml" }) as ManagerAgentConfig;

export function distributedRuntime(model: ModelClient = new MockModelClient(), agentClient = new MockAgentClient()): RuntimeDependencies {
  return {
    manager: managerAgent,
    registry: serviceRegistry,
    agentClient,
    identityIssuer: new MockDelegationAuthority({ issuer: "https://mock-manager.sre.local", secret: "local-test-delegation-secret-32-bytes-minimum" }),
    model,
    synthesisModel: model,
    requestDeadlineMs: 5_000,
    defaultEnvironment: "prod",
  };
}
