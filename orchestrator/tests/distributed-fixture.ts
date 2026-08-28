
import { loadAgentCatalog } from "@sre/config";
import { MockDelegationAuthority } from "@sre/auth";
import { loadAgentInstance, type ManagerAgentConfig } from "@sre/config";
import { MockModelClient, type ModelClient } from "@sre/llm";
import { MockSpecialistTransport, type RuntimeDependencies } from "../src/index.ts";

export const serviceRegistry = loadAgentCatalog("agents/registry.yaml");
export const managerAgent = loadAgentInstance({ configFile: "agents/manager.yaml" }) as ManagerAgentConfig;

export function distributedRuntime(model: ModelClient = new MockModelClient(), agentClient = new MockSpecialistTransport()): RuntimeDependencies {
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
