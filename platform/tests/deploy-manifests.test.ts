import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

/**
 * `npm run check` renders the Helm charts, so a broken chart is caught. The
 * manifests applied with `kubectl` directly — the Argo AppProject, Applications
 * and ApplicationSets — were checked by nothing, and an unparseable one fails
 * only at the moment someone applies it to a cluster.
 *
 * The escape that prompted this: a Helm parameter written as
 * `{ name: gitSync.egressCIDRs[0], ... }`, where the unquoted `[0]` opens a
 * flow sequence inside a flow mapping. Valid-looking, and a YAML syntax error.
 */

const deployRoot = join(import.meta.dirname, "..", "..", "deploy");

function yamlFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return yamlFilesUnder(full);
    return entry.name.endsWith(".yaml") || entry.name.endsWith(".yml") ? [full] : [];
  });
}

describe("cluster manifests applied outside Helm still parse", () => {
  // the Helm charts hold Go templates and are NOT YAML until rendered; they are
  // covered by `helm lint` / `helm template` in `npm run validate:deploy`
  const files = yamlFilesUnder(join(deployRoot, "argocd"));

  it("finds the manifests to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file.slice(deployRoot.length + 1), file]))("%s parses", (_name, file) => {
    const errors = parseAllDocuments(readFileSync(file, "utf8")).flatMap((doc) => doc.errors);
    expect(errors.map((error) => error.message)).toEqual([]);
  });
});

/**
 * THE APPPROJECT MUST BE RECONCILED, NOT BOOTSTRAPPED AND FORGOTTEN.
 *
 * It was applied once by bootstrap-local.sh and owned by nothing afterwards. The
 * live copy lost ConfigMap and Route from its namespaceResourceWhitelist, and
 * every Application in the project then failed to sync — a total GitOps outage
 * caused by an object no Application was watching, and invisible in the health
 * of the Applications it broke.
 *
 * A root Application now syncs the GitOps objects, and lists itself among them
 * so it manages itself.
 */
describe("the GitOps objects are themselves under GitOps", () => {
  const root = parseAllDocuments(readFileSync(join(deployRoot, "argocd", "applications", "gitops-local.yaml"), "utf8"))[0]
    ?.toJS() as { spec: { project: string; source: { directory?: { include?: string } }; syncPolicy?: { automated?: { selfHeal?: boolean } } } };
  const included = root.spec.source.directory?.include ?? "";

  it("reconciles the AppProject", () => {
    expect(included).toContain("projects/sre-agent-platform.yaml");
  });

  it("reconciles the root Application itself, so the root is not a drift hole in turn", () => {
    expect(included).toContain("applications/gitops-local.yaml");
  });

  it("names local desired state exhaustively rather than recursing onto production", () => {
    // a bare recurse over deploy/argocd would also sweep in the PRODUCTION
    // ApplicationSet and aim a laptop cluster at production desired state
    expect(included).toContain("applicationsets/runtime-local.yaml");
    expect(included).not.toContain("applicationsets/runtime.yaml");
  });

  it("keeps the root outside the workload project, which must not be able to rewrite its own authorization", () => {
    expect(root.spec.project).not.toBe("sre-agent-platform");
    // selfHeal is what reverts a hand-edited AppProject
    expect(root.spec.syncPolicy?.automated?.selfHeal).toBe(true);
  });
});
