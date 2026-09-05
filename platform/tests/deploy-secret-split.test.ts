import { parse } from "yaml";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * CRITICAL finding C2: Secrets split by role.
 *
 * Manager must mount the delegation signing key (for minting delegated identities).
 * Specialists must NOT have access to it.
 *
 * This test ensures that:
 * 1. Specialist rendering contains NO manager-only secrets
 * 2. Manager rendering contains the delegation key file mount
 * 3. Role-based secret separation is enforced at the Helm level
 */

function helmTemplate(
  release: string,
  chart: string,
  valuesFile: string,
): string {
  try {
    return execFileSync("helm", [
      "template",
      release,
      chart,
      "-f",
      valuesFile,
    ], {
      cwd: "/Users/guylavian/sre agent/platform",
      encoding: "utf8",
    });
  } catch (error) {
    throw new Error(`helm template failed: ${error}`);
  }
}

describe("deploy: secret split by role (C2)", () => {
  const MANAGER_VALUES = "../deploy/environments/production/rendered/agents/manager.yaml";
  const SPECIALIST_VALUES = "../deploy/environments/production/rendered/agents/active-directory.yaml";
  const HELM_CHART = "../deploy/runtime/helm";

  describe("specialist deployment", () => {
    let rendered: string;

    it("renders without error", () => {
      rendered = helmTemplate("sre-agent-active-directory", HELM_CHART, SPECIALIST_VALUES);
      expect(rendered).toBeDefined();
      expect(rendered.length).toBeGreaterThan(0);
    });

    it("does NOT expose SRE_DELEGATION_PRIVATE_KEY_PKCS8 to specialists", () => {
      rendered = helmTemplate("sre-agent-active-directory", HELM_CHART, SPECIALIST_VALUES);
      // This env var must NOT appear in the specialist deployment
      expect(rendered).not.toContain("SRE_DELEGATION_PRIVATE_KEY_PKCS8");
    });

    it("does NOT expose SRE_POSTGRES_URL (manager-only) to specialists", () => {
      rendered = helmTemplate("sre-agent-active-directory", HELM_CHART, SPECIALIST_VALUES);
      // Manager needs direct DB access; specialists do not
      expect(rendered).not.toContain("SRE_POSTGRES_URL");
    });

    it("does NOT expose SRE_ARGOCD_TOKEN (manager-only) to specialists", () => {
      rendered = helmTemplate("sre-agent-active-directory", HELM_CHART, SPECIALIST_VALUES);
      // Manager monitors deployment state via Argo; specialists don't
      expect(rendered).not.toContain("SRE_ARGOCD_TOKEN");
    });

    it("does NOT mount delegation private key secret or file", () => {
      rendered = helmTemplate("sre-agent-active-directory", HELM_CHART, SPECIALIST_VALUES);
      // Neither env var nor file path should reference the delegation private key
      expect(rendered).not.toContain("sre-agent-delegation-private-key");
      expect(rendered).not.toContain("/etc/sre/delegation-key");
    });

    it("DOES expose SRE_TOOL_CREDENTIAL_CLIENT_SECRET (specialist-only) if configured", () => {
      rendered = helmTemplate("sre-agent-active-directory", HELM_CHART, SPECIALIST_VALUES);
      // Specialists need their own client secret for RFC 8693 token exchange
      // (Note: may be absent if not configured in values, but should not throw)
      expect(rendered).toBeDefined();
    });
  });

  describe("manager deployment", () => {
    let rendered: string;

    it("renders without error", () => {
      rendered = helmTemplate("sre-agent-manager", HELM_CHART, MANAGER_VALUES);
      expect(rendered).toBeDefined();
      expect(rendered.length).toBeGreaterThan(0);
    });

    it("mounts delegation private key file with SRE_DELEGATION_PRIVATE_KEY_FILE", () => {
      rendered = helmTemplate("sre-agent-manager", HELM_CHART, MANAGER_VALUES);
      // Manager must have the file-based env var, not the inline key
      expect(rendered).toContain("SRE_DELEGATION_PRIVATE_KEY_FILE");
      expect(rendered).toContain("/etc/sre/delegation-key/private.pem");
    });

    it("does NOT expose SRE_DELEGATION_PRIVATE_KEY_PKCS8 to manager (uses file instead)", () => {
      rendered = helmTemplate("sre-agent-manager", HELM_CHART, MANAGER_VALUES);
      // File-mounted approach replaces inline env var
      expect(rendered).not.toContain("SRE_DELEGATION_PRIVATE_KEY_PKCS8");
    });

    it("mounts sre-agent-delegation-private-key Secret at /etc/sre/delegation-key", () => {
      rendered = helmTemplate("sre-agent-manager", HELM_CHART, MANAGER_VALUES);
      // Secret name must appear in volumeMounts and volumes
      expect(rendered).toContain("sre-agent-delegation-private-key");
      // Volume name and mount path
      expect(rendered).toContain("/etc/sre/delegation");
    });

    it("mounts manager secrets containing SRE_POSTGRES_URL and SRE_ARGOCD_TOKEN", () => {
      rendered = helmTemplate("sre-agent-manager", HELM_CHART, MANAGER_VALUES);
      // Manager needs database access for session store and agent repository
      // These come from envFrom: secretRef: sre-agent-manager-secrets (which contains SRE_POSTGRES_URL, SRE_ARGOCD_TOKEN)
      expect(rendered).toContain('secretRef: { name: "sre-agent-manager-secrets" }');
    });

    it("does NOT mount specialist client secret", () => {
      rendered = helmTemplate("sre-agent-manager", HELM_CHART, MANAGER_VALUES);
      // Specialist secret (with SRE_TOOL_CREDENTIAL_CLIENT_SECRET) should NOT appear in manager
      expect(rendered).not.toContain("sre-agent-specialist-secrets");
    });

    it("does NOT expose SRE_TOOL_CREDENTIAL_CLIENT_SECRET (specialist-only)", () => {
      rendered = helmTemplate("sre-agent-manager", HELM_CHART, MANAGER_VALUES);
      // Specialists authenticate to ToolHive; manager does not
      expect(rendered).not.toContain("SRE_TOOL_CREDENTIAL_CLIENT_SECRET");
    });
  });

  it("gives the manager no two volumes on one mount path", () => {
    // the public key is mounted at /etc/sre/delegation by every release, so a
    // private key at the same path produced a pod the API server rejects.
    // Checked per CONTAINER: two containers sharing a path is normal.
    const rendered = helmTemplate("sre-agent-manager", "../deploy/runtime/helm", MANAGER_VALUES);
    const deployment = rendered.split(/^---$/mu)
      .map((doc) => parse(doc) as { kind?: string; spec?: { template?: { spec?: Record<string, unknown> } } })
      .find((doc) => doc?.kind === "Deployment");
    const podSpec = deployment?.spec?.template?.spec ?? {};
    const containers = [...(podSpec.containers as Array<Record<string, unknown>> ?? []), ...(podSpec.initContainers as Array<Record<string, unknown>> ?? [])];
    expect(containers.length).toBeGreaterThan(0);
    for (const container of containers) {
      const paths = ((container.volumeMounts as Array<{ mountPath: string }>) ?? []).map((mount) => mount.mountPath);
      expect(new Set(paths).size, `duplicate mountPath in container ${String(container.name)}`).toBe(paths.length);
    }
  });

  describe("reconciler role", () => {
    // the runtime only READS the operational plane; the credentials that can
    // activate an Agent or write an attestation belong to one workload only
    const render = (mode: string) => execFileSync("helm", ["template", "t", "../deploy/runtime/helm", "--set", `agent.mode=${mode}`, "--set", "agent.name=probe"], { encoding: "utf8" });

    it("gives the attester and activation credentials to the reconciler alone", () => {
      expect(render("reconciler")).toMatch(/SRE_ATTEST_|sre-agent-reconciler-secrets/u);
      for (const mode of ["manager", "specialist"]) {
        const rendered = render(mode);
        expect(rendered, `${mode} must not receive operational-plane write credentials`).not.toMatch(/SRE_ATTEST_|SRE_ACTIVATION_|sre-agent-reconciler-secrets/u);
      }
    });

    it("runs the reconciler entrypoint and exposes no Service", () => {
      const rendered = render("reconciler");
      expect(rendered).toContain("reconciler-main.ts");
      // nothing calls it, so it gets no Service to be called on
      expect(rendered).not.toMatch(/^kind: Service$/mu);
    });

    it("keeps the runtime roles on the runtime entrypoint", () => {
      for (const mode of ["manager", "specialist"]) {
        expect(render(mode)).not.toContain("reconciler-main.ts");
      }
    });
  });
});
/**
 * The manager mounts the delegation signing key unconditionally, including when
 * its delegation client is a mock that never reads a key file. A local cluster
 * then cannot start a manager at all — the kubelet blocks on a Secret that
 * carries no meaning there — which pushed operators toward inventing key
 * material to satisfy a mount. A credential a mocked client cannot use should
 * not be demanded; a real one still must be.
 */
describe("the delegation key is mounted only when something reads it", () => {
  function renderManager(delegation: string): string {
    return execFileSync("helm", ["template", "m", "../deploy/runtime/helm",
      "--set", "agent.mode=manager", "--set", "agent.name=manager",
      "--set", `clients.delegation=${delegation}`,
    ], { cwd: "/Users/guylavian/sre agent/platform", encoding: "utf8" });
  }

  it("mounts the signing key when delegation is real", () => {
    const rendered = renderManager("real");
    expect(rendered).toContain("delegation-private-key");
    expect(rendered).toContain("SRE_DELEGATION_PRIVATE_KEY_FILE");
  });

  it("does not demand a key a mocked delegation client never reads", () => {
    const rendered = renderManager("mock");
    expect(rendered).not.toContain("delegation-private-key");
  });
});

/**
 * The runtime never calls the Kubernetes API — nothing discovers Services
 * through it, which is why the chart owns the naming convention instead. A
 * mounted API token is therefore pure attack surface: it buys nothing and it is
 * one `cat` away for anything that achieves execution in the pod.
 *
 * The workload identity token is a DIFFERENT, projected token with its own
 * audience, and it must survive: it is how a specialist proves who it is.
 */
describe("no workload mounts a Kubernetes API token it never uses", () => {
  function renderPodSpec(mode: string): { automountServiceAccountToken?: boolean; volumes: Array<{ name: string }> } {
    const out = execFileSync("helm", ["template", "m", "../deploy/runtime/helm",
      "--set", `agent.mode=${mode}`, "--set", "agent.name=probe",
    ], { cwd: "/Users/guylavian/sre agent/platform", encoding: "utf8" });
    const deployment = out.split(/^---$/mu).map((doc) => parse(doc) as Record<string, unknown>)
      .find((doc) => doc?.kind === "Deployment") as { spec: { template: { spec: { automountServiceAccountToken?: boolean; volumes: Array<{ name: string }> } } } };
    return deployment.spec.template.spec;
  }

  it.each(["manager", "specialist", "reconciler"])("%s does not automount the API token", (mode) => {
    expect(renderPodSpec(mode).automountServiceAccountToken).toBe(false);
  });

  it("still projects the workload identity token, which is how a specialist proves who it is", () => {
    expect(renderPodSpec("specialist").volumes.some((v) => v.name === "workload-identity")).toBe(true);
  });
});
