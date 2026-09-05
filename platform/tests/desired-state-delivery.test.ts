import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATHS, DEPLOY_ROOT, configFiles, loadAgentRegistry, renderedAgentValuesSchema } from "@sre/config";
import { DesiredStateSource, fingerprint } from "@sre/runtime-host";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * DESIRED STATE REACHES A RUNNING POD WITHOUT A NEW IMAGE.
 *
 * The runtime image bakes `platform/config` and `deploy/environments` so a
 * working tree and a container resolve the same relative paths. That is right
 * for code and wrong for Agent desired state: a merged pull request changed
 * Git, Argo reconciled, and the running Manager went on reading the registry
 * from the image it was built with — so discovering a new Agent needed an image
 * rebuild, which is precisely the lifecycle this platform promises it does not.
 *
 * The rendered values now carry that state as a projection of Git, and the
 * chart mounts it over the baked copy. These tests hold that chain together.
 */

const CHART = "../deploy/runtime/helm/templates";
const rendered = (environment: string, agent: string) =>
  renderedAgentValuesSchema.parse(parseYaml(readFileSync(`${DEPLOY_ROOT}/environments/${environment}/rendered/agents/${agent}.yaml`, "utf8")));

describe("the rendered values carry the desired state Argo must deliver", () => {
  it("gives the Manager every canonical Agent document and prompt", () => {
    const registry = loadAgentRegistry(CONFIG_PATHS);
    const canonical = [...registry.listSpecialists().map((agent) => agent.name), "manager"].sort();
    const state = rendered("production", "manager").desiredState;

    // the Manager's catalog is derived from the CANONICAL registry — every
    // Agent that exists, deployed here or not — so all of it must travel
    expect(Object.keys(state?.agents ?? {}).sort()).toEqual(canonical.map((name) => `${name}.yaml`));
    expect(Object.keys(state?.prompts ?? {}).length).toBe(canonical.length);
  });

  it("gives a specialist its OWN document and prompt, and nothing about anyone else", () => {
    const state = rendered("production", "keycloak").desiredState;
    /*
     * Its own document is not optional. `AGENT_CONFIG` resolves into the agents
     * directory, so without this mount a specialist created after the image was
     * built finds no document and cannot start — the headline case of this
     * whole delivery path, and it was broken while only the prompt travelled.
     */
    expect(Object.keys(state?.agents ?? {})).toEqual(["keycloak.yaml"]);
    expect(Object.keys(state?.prompts ?? {})).toEqual(["keycloak.md"]);
    // but nothing about the rest of the estate, which it never reads
    expect(state?.overlays).toBeUndefined();
    expect(state?.environmentFiles).toBeUndefined();
  });

  it("stamps one bundle revision into every mount, so a pod can spot a half-propagated update", () => {
    // the four ConfigMaps are separate objects and the kubelet swaps each
    // independently; without a shared stamp, overlays from commit N+1 beside
    // documents from commit N is undetectable — every file individually valid
    const manager = rendered("production", "manager").desiredState;
    const specialist = rendered("production", "keycloak").desiredState;
    expect(manager?.revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(specialist?.revision).toMatch(/^[a-f0-9]{64}$/u);
    // each workload mounts its own bundle, so the two digests differ by design
    expect(manager?.revision).not.toBe(specialist?.revision);
  });

  it("carries the deployment overlays, so enable and disable travel too", () => {
    const state = rendered("production", "manager").desiredState;
    const overlays = configFiles(`${DEPLOY_ROOT}/environments/production/agents`);
    expect(Object.keys(state?.overlays ?? {}).sort()).toEqual(overlays);
    // and the environment files the Manager resolves endpoints and previews with
    expect(Object.keys(state?.environmentFiles ?? {}).sort()).toEqual(["environment.yaml", "manager.yaml", "model-bindings.yaml"]);
  });

  it("is a PROJECTION: every embedded file is byte-identical to Git", () => {
    // the moment this drifts, Git has stopped being the source of truth and
    // the mounted copy has quietly become a second one
    const state = rendered("production", "manager").desiredState;
    for (const [name, contents] of Object.entries(state?.agents ?? {})) {
      expect(contents.trimEnd(), name).toBe(readFileSync(`${CONFIG_PATHS.agentsDir}/${name}`, "utf8").trimEnd());
    }
    for (const [name, contents] of Object.entries(state?.overlays ?? {})) {
      expect(contents.trimEnd(), name).toBe(readFileSync(`${DEPLOY_ROOT}/environments/production/agents/${name}`, "utf8").trimEnd());
    }
  });

  it("changes the rendered file whenever an Agent's desired state changes", () => {
    // Argo diffs the rendered values; if a prompt edit did not change them,
    // there would be nothing for it to sync and the pod would keep the old text
    const before = readFileSync(`${DEPLOY_ROOT}/environments/production/rendered/agents/keycloak.yaml`, "utf8");
    expect(before).toContain("promptSha256:");
    // the body travels beside the digest, so the change is reviewable as a diff
    expect(before).toContain("desiredState:");
    expect(before).toContain("keycloak.md: |-");
  });
});

describe("the chart mounts it in a way Kubernetes actually updates", () => {
  const deployment = readFileSync(`${CHART}/deployment.yaml`, "utf8");
  const configMaps = readFileSync(`${CHART}/desired-state.yaml`, "utf8");

  it("mounts whole directories, never subPath", () => {
    /*
     * A subPath mount is resolved once at container start and NEVER receives a
     * ConfigMap update. Using one here would have reproduced the exact bug this
     * work removes — a pod serving the configuration it booted with — while
     * looking completely correct in the manifest.
     */
    const mounts = deployment.split("\n").filter((line) => line.includes("name: desired-") && line.includes("mountPath"));
    expect(mounts.length, "no desired-state volumeMounts found at all").toBe(4);
    for (const line of mounts) {
      expect(line, "a desired-state mount must not use subPath").not.toContain("subPath");
    }
    // every mounted volume is also declared, or the pod fails to schedule
    for (const name of ["desired-agents", "desired-prompts", "desired-environment", "desired-overlays"]) {
      expect(deployment, `${name} is mounted but never declared`).toContain(`- name: ${name}\n          configMap:`);
    }
  });

  it("mounts over the paths the runtime actually reads", () => {
    expect(deployment).toContain('mountPath: "/app/platform/config/agents"');
    expect(deployment).toContain('mountPath: "/app/platform/config/prompts"');
    // the environment directory and the overlays inside it; the kubelet sorts
    // mounts by path, so the nested one lands within the outer one
    expect(deployment).toContain('printf "/app/deploy/environments/%s" .Values.deploymentEnvironment');
    expect(deployment).toContain('printf "/app/deploy/environments/%s/agents" .Values.deploymentEnvironment');
  });

  it("creates one ConfigMap per mounted directory", () => {
    for (const suffix of ["-agents", "-prompts", "-overlays", "-environment-files"]) {
      expect(configMaps, `no ConfigMap for ${suffix}`).toContain(`{{ $fullname }}${suffix}`);
    }
  });

  it("keeps ONE generic image: nothing in the chart names an agent", () => {
    // one image per Agent would make "deploy a new Agent" a build, which is the
    // thing this whole path exists to avoid
    const registry = loadAgentRegistry(CONFIG_PATHS);
    for (const agent of registry.listSpecialists()) {
      expect(deployment, `deployment.yaml names ${agent.name}`).not.toContain(`"${agent.name}"`);
    }
    expect(deployment).toContain('image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"');
  });
});

describe("reading a ConfigMap volume safely", () => {
  /** Build the layout a kubelet actually creates: `..data` → a timestamped dir. */
  function projectedVolume(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "sre-projected-"));
    const version = join(root, "..2026_01_01_00_00_00.111111111");
    mkdirSync(version);
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(version, name), contents, "utf8");
    symlinkSync(version, join(root, "..data"));
    for (const name of Object.keys(files)) symlinkSync(join(root, "..data", name), join(root, name));
    return root;
  }

  it("lists the real files and none of the kubelet's bookkeeping", () => {
    const root = projectedVolume({ "a.yaml": "one", "b.yaml": "two" });
    try {
      // `..data` and `..2026_...` are how a projected volume is built; treating
      // them as configuration would fail the load on every single pod
      expect(configFiles(root)).toEqual(["a.yaml", "b.yaml"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not report a change when only the bookkeeping name moved", () => {
    // the timestamped directory is renamed on every resync even when no file
    // content changed; counting that as a change would re-validate every Agent
    // on a timer forever
    const root = projectedVolume({ "a.yaml": "one" });
    try {
      const before = fingerprint([root]);
      symlinkSync(join(root, "..2026_01_01_00_00_00.111111111"), join(root, "..2026_01_01_00_00_01.222222222"));
      expect(fingerprint([root])).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a config swap can never expose partial state", () => {
  it("discards a load that straddled a change and keeps the last good snapshot", () => {
    let revision = "r1";
    let loads = 0;
    const source = new DesiredStateSource(
      () => {
        loads += 1;
        // the volume moves DURING the read, exactly as an atomic symlink swap
        // does between one file and the next
        if (loads === 2) revision = "r3";
        return snapshot(`load-${loads}`);
      },
      () => revision,
      { revalidateMs: 0, now: () => 0 },
    );
    expect(source.current().environment).toBe("load-1");

    revision = "r2";
    const after = source.current();
    // it must NOT have activated the read taken across the swap; the retry sees
    // a stable fingerprint and activates that instead
    expect(after.environment).toBe("load-3");
    expect(after.error).toBeUndefined();
  });

  it("never activates a malformed refresh, and says why", () => {
    let revision = "r1";
    let broken = false;
    const source = new DesiredStateSource(
      () => { if (broken) throw new Error("schema validation failed for kafka.yaml"); return snapshot("good"); },
      () => revision,
      { revalidateMs: 0, now: () => 0 },
    );
    broken = true;
    revision = "r2";
    const stale = source.current();
    // last known good, plus a clear reconciliation error — a half-parsed
    // registry must never reach the catalog
    expect(stale.environment).toBe("good");
    expect(stale.error).toMatch(/kafka\.yaml/u);
    expect(stale.enabledAgentIds).toEqual([]);
  });

  it("two replicas over the same desired state agree on the revision", () => {
    // Manager replicas each read their own mounted copy; if the fingerprint
    // were not a pure function of content they would diverge and route
    // differently from one another
    const directory = `${DEPLOY_ROOT}/environments/production/agents`;
    expect(fingerprint([directory])).toBe(fingerprint([directory]));
    expect(configFiles(directory)).toEqual(configFiles(directory));
  });
});

function snapshot(environment: string) {
  return { registry: {} as never, catalog: { listEnabled: () => [] } as never, environment, enabledAgentIds: [], overlays: new Map() };
}

describe("production refuses to serve desired state baked into its image", () => {
  const PRODUCTION = {
    SRE_ENV: "production",
    AGENT_CONFIG: "config/agents/manager.yaml",
    SRE_OIDC_ISSUER: "https://idp.internal/realms/sre",
    SRE_OIDC_AUDIENCE: "sre-assistant",
    SRE_OIDC_JWKS_URI: "https://idp.internal/realms/sre/protocol/openid-connect/certs",
    SRE_LLM_BASE_URL: "https://vllm.internal/v1",
    SRE_LLM_MODEL: "qwen3-8b",
    SRE_TOOLHIVE_URL: "https://toolhive.internal",
    SRE_POSTGRES_URL: "postgres://sre@db.internal/sre",
    SRE_DELEGATION_ISSUER: "https://manager.internal",
    SRE_WORKLOAD_TOKEN_FILE: "/var/run/secrets/sre-workload/token",
    // production is fail-closed on mocks; these must be real for the config to
    // load at all, which is what lets the mount check be the thing under test
    SRE_CLIENT_OIDC: "real",
    SRE_CLIENT_LLM: "real",
    SRE_CLIENT_TOOLHIVE: "real",
    SRE_CLIENT_POSTGRES: "real",
    SRE_CLIENT_AGENT: "real",
    SRE_CLIENT_DELEGATION: "real",
    SRE_DELEGATION_PRIVATE_KEY_PKCS8: "unused-because-startup-fails-earlier",
    SRE_INTERNAL_OIDC_JWKS_URI: "https://idp.internal/realms/sre/protocol/openid-connect/certs",
    SRE_INTERNAL_EXPECTED_SUBJECT: "system:serviceaccount:sre-assistant:sre-agent-manager",
    SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT: "https://idp.internal/realms/sre/protocol/openid-connect/token",
    SRE_TOOL_CREDENTIAL_CLIENT_SECRET: "unused-because-startup-fails-earlier",
  };

  it("fails startup when the Agent registry is not a mounted volume", async () => {
    const { buildDependencies } = await import("@sre/runtime-host");
    /*
     * The working tree's `config/agents` is a plain directory, which is exactly
     * what the image ships. In production that must be a hard startup failure:
     * a pod that quietly fell back to it would serve the estate as it stood on
     * BUILD DAY and never discover an Agent merged since — with no error
     * anywhere, which is the whole failure mode this delivery path removes.
     */
    expect(() => buildDependencies(PRODUCTION)).toThrow(/desired state is not mounted/u);
  });

  it("stops a SPECIALIST whose prompt is not mounted either", async () => {
    const { buildDependencies } = await import("@sre/runtime-host");
    // a specialist reads one Agent document and its prompt; a baked prompt is
    // the same staleness in a smaller blast radius
    expect(() => buildDependencies({ ...PRODUCTION, AGENT_CONFIG: "config/agents/keycloak.yaml", ROLE: "specialist" }))
      .toThrow(/desired state is not mounted/u);
  });

  it("lets a deployment with no GitOps path opt out, explicitly and on purpose", async () => {
    const { buildDependencies } = await import("@sre/runtime-host");
    /*
     * There is a way to run without mounts; there is no way to reach it by
     * accident, and the switch is named for what you are accepting.
     *
     * Asserted on a SPECIALIST: the manager path would go on to import a real
     * delegation private key, and this fixture carries a placeholder, so the
     * failure would be about the key rather than about the mount.
     */
    expect(() => buildDependencies({ ...PRODUCTION, AGENT_CONFIG: "config/agents/keycloak.yaml", ROLE: "specialist", SRE_ALLOW_BAKED_DESIRED_STATE: "true" }))
      .not.toThrow(/desired state is not mounted/u);
  });

  it("does not impose the check on local development", async () => {
    const { buildDependencies } = await import("@sre/runtime-host");
    // a working tree has no projected volumes and never will; requiring one
    // here would make the platform impossible to run on a laptop
    expect(() => buildDependencies({ SRE_ENV: "local", AGENT_CONFIG: "config/agents/manager.yaml", SRE_CLIENT_AGENT: "mock" })).not.toThrow();
  });
});

describe("mounts that have not all reached the same commit", () => {
  function volume(revision?: string): string {
    const root = mkdtempSync(join(tmpdir(), "sre-mount-"));
    if (revision !== undefined) writeFileSync(join(root, ".revision"), revision, "utf8");
    return root;
  }

  it("refuses a snapshot whose ConfigMaps disagree", async () => {
    const { assertMountsAgree } = await import("@sre/runtime-host");
    const a = volume("aaa");
    const b = volume("bbb");
    try {
      /*
       * The straddle retry cannot catch this: each directory is internally
       * complete, nothing is mid-write, and the fingerprint before and after
       * the read is identical. Only comparing the stamp across mounts sees it.
       */
      expect(() => assertMountsAgree([a, b])).toThrow(/mid-propagation/u);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("accepts mounts that agree", async () => {
    const { assertMountsAgree } = await import("@sre/runtime-host");
    const a = volume("same");
    const b = volume("same");
    try {
      expect(() => assertMountsAgree([a, b])).not.toThrow();
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("ignores directories with no stamp, so a working tree still runs", async () => {
    const { assertMountsAgree } = await import("@sre/runtime-host");
    const stamped = volume("only-one");
    const plain = volume();
    try {
      // a laptop has no ConfigMaps and never will; requiring a stamp would make
      // the platform impossible to run outside a cluster
      expect(() => assertMountsAgree([stamped, plain])).not.toThrow();
      expect(() => assertMountsAgree(["/definitely/not/here"])).not.toThrow();
    } finally {
      rmSync(stamped, { recursive: true, force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("a specialist re-reads its own document while running", () => {
  /**
   * The Manager re-read the registry on a timer; the specialist path did not.
   * It captured `loadAgentInstance` once at startup and served every request
   * from that object forever, so a merged change reached the pod's mounted
   * files and was never looked at again.
   *
   * NARROWING A GRANT is the case that matters: enforcement reads the tool
   * allowlist from this object, so a stale one keeps permitting access that Git
   * has already taken away.
   */
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "sre-specialist-"));
    cpSync(join(process.cwd(), "config"), join(root, "config"), { recursive: true });
    return root;
  }

  it("picks up a narrowed tool grant without a restart", async () => {
    const { agentInstanceSource } = await import("@sre/runtime-host");
    const root = repo();
    let clock = 0;
    try {
      const agentOf = agentInstanceSource(
        { configFile: "config/agents/keycloak.yaml", mcpServersDir: "config/mcp-servers", agentsDir: "config/agents", promptsDir: "config/prompts", baseDir: root, revalidateMs: 1 },
        { now: () => clock },
      );
      const grantFor = (mcp: string) => {
        const spec = agentOf().spec;
        // `agentInstanceSource` returns either role; only a specialist has access
        if (spec.type !== "specialist") throw new Error("expected a specialist document");
        return spec.access.find((entry) => entry.mcp === mcp)?.tools ?? [];
      };
      expect(grantFor("keycloak").length).toBeGreaterThan(1);

      // Git narrows the grant to a single tool and Argo delivers the new file
      const file = join(root, "config/agents/keycloak.yaml");
      // the keycloak MCP's grant is the one whose tool list starts `keycloak_`
      writeFileSync(file, readFileSync(file, "utf8").replace(/tools: \[keycloak_[^\]]*\]/u, "tools: [keycloak_health]"), "utf8");
      clock += 60_000;

      expect(grantFor("keycloak")).toEqual(["keycloak_health"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the last document that validated when a merge is malformed", async () => {
    const { agentInstanceSource } = await import("@sre/runtime-host");
    const root = repo();
    let clock = 0;
    try {
      const agentOf = agentInstanceSource(
        { configFile: "config/agents/keycloak.yaml", mcpServersDir: "config/mcp-servers", agentsDir: "config/agents", promptsDir: "config/prompts", baseDir: root, revalidateMs: 1 },
        { now: () => clock },
      );
      expect(agentOf().name).toBe("keycloak");

      writeFileSync(join(root, "config/agents/keycloak.yaml"), "apiVersion: sre.ai/v1alpha1\nkind: Agent\nspec: {}\n", "utf8");
      clock += 60_000;

      // a specialist that stopped serving because someone merged a typo would
      // be a worse failure than one still enforcing the policy it understands
      const spec = agentOf().spec;
      expect(agentOf().name).toBe("keycloak");
      expect(spec.type === "specialist" && spec.access.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
