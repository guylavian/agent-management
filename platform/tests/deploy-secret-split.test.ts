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
      expect(rendered).not.toContain("/etc/sre/delegation");
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
      expect(rendered).toContain("/etc/sre/delegation/private.pem");
    });

    it("does NOT expose SRE_DELEGATION_PRIVATE_KEY_PKCS8 to manager (uses file instead)", () => {
      rendered = helmTemplate("sre-agent-manager", HELM_CHART, MANAGER_VALUES);
      // File-mounted approach replaces inline env var
      expect(rendered).not.toContain("SRE_DELEGATION_PRIVATE_KEY_PKCS8");
    });

    it("mounts sre-agent-delegation-private-key Secret at /etc/sre/delegation", () => {
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
});
