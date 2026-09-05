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
