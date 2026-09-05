import { incrementMetric } from "@sre/telemetry";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import {
  loadAgentRegistry,
  loadDeploymentEnvironment,
  loadAgentInstance,
  loadEffectiveAgentCatalog,
  type AgentDeploymentOverlay,
  type AgentRegistry,
  type LoadOptions,
  type ManagerAgentConfig,
  type SpecialistAgentConfig,
  type StaticAgentCatalog,
} from "@sre/config";

/**
 * GIT DESIRED STATE, re-read while the process runs.
 *
 * Every Agent document and every deployment overlay is a file in the repository
 * that Argo CD syncs onto the pod. Loading them once at startup meant a merged
 * pull request changed nothing until someone restarted the Manager: the Agent
 * was in Git, its ConfigMap was already updated on disk, and the console still
 * showed the world as it had been at boot. That restart was invisible, manual,
 * and easy to forget — so an operator's only evidence that a merge had worked
 * was that nothing happened.
 *
 * This is deliberately ONE source for both readers. The management API and the
 * Manager's routing catalog are derived from the same snapshot, so the console
 * cannot show a set of agents the router does not have.
 *
 * FAIL-CLOSED IS PRESERVED. The FIRST load throws — a process whose
 * configuration does not validate must not start. A later reload that fails
 * keeps the last good snapshot and records the error, because refusing to serve
 * because a NEW file is malformed would take a working platform down over a
 * change to an agent nobody was using; the error is reported instead, and the
 * console renders it as FAILED rather than as silence.
 */
export interface DesiredState {
  /** the canonical set: every Agent that exists, deployed here or not */
  registry: AgentRegistry;
  /** canonical ∩ this environment's deployment overlays — what the Manager may route to */
  catalog: StaticAgentCatalog;
  environment: string;
  enabledAgentIds: string[];
  /**
   * The raw deployment overlays. The catalog collapses "no overlay" and
   * "overlay says enabled: false" into a single `enabled: false`, and those are
   * different reconciliation states — one is not-deployed-here, the other is a
   * deliberate disable. The console has to be able to tell them apart.
   */
  overlays: ReadonlyMap<string, AgentDeploymentOverlay>;
  /** changes whenever any source file does; the console shows it, tests assert on it */
  revision: string;
  loadedAt: string;
  /**
   * The failure of the most recent reload attempt. Present means the snapshot
   * above is stale-but-valid and something merged since does not load.
   */
  error?: string;
}

export interface DesiredStateOptions extends LoadOptions {
  deploymentEnvironmentDir: string;
  /** how long a snapshot is trusted before the cheap fingerprint check re-runs */
  revalidateMs?: number;
}

const DEFAULT_REVALIDATE_MS = 5_000;

/**
 * How many times a load may be retried when the fingerprint moves underneath
 * it. Three is enough for a kubelet symlink swap, which happens once; more
 * would mean something is rewriting the volume continuously, and spinning on
 * that is worse than reporting it.
 */
const LOAD_ATTEMPTS = 3;

export class DesiredStateSource {
  readonly #load: () => Omit<DesiredState, "revision" | "loadedAt">;
  readonly #fingerprint: () => string;
  readonly #revalidateMs: number;
  readonly #now: () => number;
  #snapshot: DesiredState;
  #checkedAtMs: number;

  constructor(
    load: () => Omit<DesiredState, "revision" | "loadedAt">,
    fingerprint: () => string,
    options: { revalidateMs?: number; now?: () => number } = {},
  ) {
    this.#load = load;
    this.#fingerprint = fingerprint;
    this.#revalidateMs = options.revalidateMs ?? DEFAULT_REVALIDATE_MS;
    this.#now = options.now ?? (() => Date.now());
    // the first load is NOT guarded: a bad configuration at startup throws
    this.#snapshot = { ...this.#load(), revision: this.#fingerprint(), loadedAt: new Date(this.#now()).toISOString() };
    this.#checkedAtMs = this.#now();
  }

  /**
   * The current desired state, re-reading it if the files changed.
   *
   * Two cheap gates before any parsing: the revalidation window, then the
   * fingerprint. A page that polls every few seconds therefore costs a handful
   * of `stat` calls, not a full schema validation of every Agent.
   */
  current(): DesiredState {
    const now = this.#now();
    if (now - this.#checkedAtMs < this.#revalidateMs) return this.#snapshot;
    this.#checkedAtMs = now;
    let revision: string;
    try {
      revision = this.#fingerprint();
    } catch (error) {
      // the config directory itself became unreadable; keep serving, say so
      this.#snapshot = { ...this.#snapshot, error: describe(error) };
      return this.#snapshot;
    }
    if (revision === this.#snapshot.revision && this.#snapshot.error === undefined) return this.#snapshot;
    /*
     * READ, THEN PROVE THE READ WAS OF ONE VERSION.
     *
     * A ConfigMap volume does not update in place: the kubelet writes a new
     * timestamped directory and swaps the `..data` symlink. The swap itself is
     * atomic, but a load that reads twenty files across it would take some from
     * the old version and some from the new — an Agent document paired with
     * another Agent's prompt, and every file individually valid.
     *
     * So the fingerprint is taken again AFTER the load. If it moved, the read
     * straddled a swap and is discarded rather than activated. Bounded retries,
     * because a directory changing on every attempt is a reason to keep serving
     * the last good state, not to spin.
     */
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
      try {
        const loaded = this.#load();
        const after = this.#fingerprint();
        if (after !== revision) {
          // the volume moved under us; take the newer revision and read again
          revision = after;
          continue;
        }
        this.#snapshot = { ...loaded, revision, loadedAt: new Date(now).toISOString() };
        return this.#snapshot;
      } catch (error) {
        const after = (() => { try { return this.#fingerprint(); } catch { return revision; } })();
        if (after !== revision) {
          // the failure may be an artefact of reading mid-swap rather than a
          // genuinely invalid document; try the version that is there now
          revision = after;
          continue;
        }
        // last good state, plus the reason the new one was refused
        this.#snapshot = { ...this.#snapshot, revision, error: describe(error) };
        return this.#snapshot;
      }
    }
    // every attempt straddled a change: keep serving what validated, and say so
    this.#snapshot = { ...this.#snapshot, error: "desired state changed on every read attempt; still serving the last validated snapshot" };
    return this.#snapshot;
  }
}

/**
 * Build the source from the paths a runtime already knows. Both halves come
 * from the same call, so a snapshot can never mix an old registry with a new
 * deployment overlay.
 */
/**
 * Refuse a snapshot whose mounted volumes are not all from the same commit.
 *
 * The Agent registry, the prompts and the deployment overlays arrive as
 * SEPARATE ConfigMaps, and the kubelet swaps each independently. A pod can
 * therefore hold overlays from commit N+1 beside agent documents from commit N:
 * every directory internally complete, nothing mid-write, and a fingerprint
 * taken before and after the read identical — so the straddle retry cannot see
 * it. The renderer stamps one digest of the whole bundle into every ConfigMap,
 * and disagreement here means propagation is still in flight.
 *
 * Absent stamps are normal and ignored: a working tree has no ConfigMaps, and
 * this must not make the platform unrunnable on a laptop.
 */
export function assertMountsAgree(directories: string[]): void {
  const seen = new Map<string, string>();
  for (const directory of directories) {
    let revision: string;
    try {
      revision = readFileSync(join(directory, ".revision"), "utf8").trim();
    } catch {
      continue;
    }
    if (revision.length > 0) seen.set(directory, revision);
  }
  const distinct = new Set(seen.values());
  if (distinct.size > 1) {
    throw new Error(
      `mounted desired state is mid-propagation: ${[...seen.entries()].map(([directory, revision]) => `${directory}@${revision.slice(0, 12)}`).join(", ")}`,
    );
  }
}

export function desiredStateSource(options: DesiredStateOptions, hooks: { now?: () => number } = {}): DesiredStateSource {
  const base = options.baseDir ?? process.cwd();
  const load = (): Omit<DesiredState, "revision" | "loadedAt"> => {
    // before anything is parsed: if the mounts disagree, this read would mix
    // versions, and every individual file would still validate
    assertMountsAgree([
      join(base, options.agentsDir),
      join(base, options.promptsDir),
      resolvePath(base, options.deploymentEnvironmentDir),
      join(resolvePath(base, options.deploymentEnvironmentDir), "agents"),
    ]);
    const registry = loadAgentRegistry(options);
    const catalog = loadEffectiveAgentCatalog(options);
    const deployment = loadDeploymentEnvironment(options.deploymentEnvironmentDir, base);
    return {
      registry,
      catalog,
      environment: deployment.settings.environment,
      enabledAgentIds: catalog.listEnabled().map((entry) => entry.agentId),
      overlays: deployment.overlays,
    };
  };
  const watched = [
    join(base, options.agentsDir),
    join(base, options.promptsDir),
    join(resolvePath(base, options.deploymentEnvironmentDir), "agents"),
    join(resolvePath(base, options.deploymentEnvironmentDir), "environment.yaml"),
    join(resolvePath(base, options.deploymentEnvironmentDir), "manager.yaml"),
  ];
  return new DesiredStateSource(
    load,
    () => fingerprint(watched),
    { ...(options.revalidateMs === undefined ? {} : { revalidateMs: options.revalidateMs }), ...(hooks.now ? { now: hooks.now } : {}) },
  );
}

/**
 * A change-detector over the files desired state is read from.
 *
 * mtime AND size AND the sorted file list: a ConfigMap remount replaces files
 * wholesale so mtimes move, and an agent that is DELETED changes the list even
 * if nothing else does. Deliberately not a content hash — this runs on every
 * poll, and the point is to be cheaper than the load it guards.
 *
 * ponytail: an edit that preserves BOTH byte length and mtime is missed. That
 * needs a filesystem with coarse (1s) mtime granularity and a same-length
 * rewrite inside one tick — a ConfigMap remount does not do this, and neither
 * does a merge, which always moves mtime. Upgrade path if it ever bites: hash
 * the file contents here instead, and pay a full read per poll.
 */
export function fingerprint(paths: string[]): string {
  const parts: string[] = [];
  for (const path of paths) {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      // a missing optional path is a real state, and one that must change the
      // fingerprint when it appears
      parts.push(`${path}:absent`);
      continue;
    }
    if (!stats.isDirectory()) {
      parts.push(`${path}:${stats.mtimeMs}:${stats.size}`);
      continue;
    }
    for (const name of readdirSync(path).sort()) {
      /*
       * `..data` and `..2026_01_01_...` are the kubelet's ConfigMap
       * bookkeeping. Their names change on EVERY update even when no file
       * content did, so including them would make the fingerprint report a
       * change on every resync and force a full re-validation of every Agent.
       * The real files are symlinks beside them and are listed normally.
       */
      if (name.startsWith("..")) continue;
      try {
        const entry = statSync(join(path, name));
        if (entry.isDirectory()) continue;
        parts.push(`${path}/${name}:${entry.mtimeMs}:${entry.size}`);
      } catch {
        parts.push(`${path}/${name}:absent`);
      }
    }
  }
  return parts.join("|");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A SPECIALIST'S OWN DOCUMENT, re-read while the process runs.
 *
 * The Manager re-reads the registry on a timer; the specialist path did not. It
 * captured `loadAgentInstance` once at startup and served every request from
 * that object forever — so a merged prompt edit, a changed model profile or a
 * narrowed tool grant reached the pod's mounted files and was never looked at
 * again. No error, no restart, just a pod running last week's policy.
 *
 * Narrowing a grant is the case that matters: the runtime enforces the
 * allowlist from THIS object, so a stale one keeps enforcing access that Git
 * has already taken away.
 *
 * Same safety rules as the registry: the first load throws (a specialist whose
 * document is invalid must not start), and a later failure keeps the last good
 * document and leaves the error to the caller's next read.
 */
/** The live Agent document, plus whether the last attempt to replace it failed. */
export interface AgentInstanceSource {
  current: () => ManagerAgentConfig | SpecialistAgentConfig;
  status: () => { revision: string; error?: string };
}

export function agentInstanceSource(
  options: { configFile: string; mcpServersDir: string; agentsDir: string; promptsDir: string; baseDir?: string; revalidateMs?: number },
  hooks: { now?: () => number } = {},
): AgentInstanceSource {
  const base = options.baseDir ?? process.cwd();
  const now = hooks.now ?? (() => Date.now());
  const revalidateMs = options.revalidateMs ?? DEFAULT_REVALIDATE_MS;
  const watched = [join(base, options.agentsDir), join(base, options.promptsDir)];
  const load = () => loadAgentInstance({ configFile: options.configFile, mcpServersDir: options.mcpServersDir, ...(options.baseDir ? { baseDir: options.baseDir } : {}) });

  let current = load();
  let revision = fingerprint(watched);
  let checkedAtMs = now();
  // the fingerprint that failed, kept SEPARATELY from `revision` so a failure
  // is not mistaken for a successful load of the same bytes
  let failedRevision: string | undefined;
  let lastError: string | undefined;

  const refresh = (): ManagerAgentConfig | SpecialistAgentConfig => {
    const at = now();
    if (at - checkedAtMs < revalidateMs) return current;
    checkedAtMs = at;
    let next: string;
    try {
      next = fingerprint(watched);
    } catch {
      return current;
    }
    if (next === revision) return current;
    // the same bytes that already failed: do not re-parse them every interval,
    // but do NOT clear the error either — the pod is still serving the old
    // document and that remains true until something on disk changes
    if (next === failedRevision) return current;
    try {
      // the mounts must agree before anything is parsed, or the document and
      // the prompt beside it could come from two different commits
      assertMountsAgree(watched);
      const loaded = load();
      if (fingerprint(watched) !== next) return current;
      current = loaded;
      revision = next;
      failedRevision = undefined;
      lastError = undefined;
    } catch (error) {
      // keep the last document that validated; a specialist that stopped
      // serving because someone merged a typo would be a worse failure than
      // one that keeps enforcing the policy it last understood.
      //
      // But it must be VISIBLE: silently serving last week's allowlist is the
      // failure this whole source exists to prevent, and an operator cannot
      // act on something that was never reported.
      /*
       * `revision` is NOT advanced. It used to be, which made the next call see
       * `next === revision` and return immediately — so the metric and the log
       * below fired exactly once and then went silent, while the old document
       * stayed authoritative for the life of the pod. A malformed NARROWING of
       * a policy therefore left the broader grants in force, reported nowhere.
       */
      failedRevision = next;
      lastError = error instanceof Error ? error.message : String(error);
      incrementMetric("sre_agent_policy_reload_failures_total");
      console.error(JSON.stringify({ level: "error", event: "agent.policy.reload_failed", message: "keeping the last valid Agent document", detail: error instanceof Error ? error.message : String(error) }));
    }
    return current;
  };

  return {
    current: refresh,
    // readiness reads this: a specialist still enforcing a document it could
    // not replace is not ready to be trusted with the new one
    status: () => (lastError === undefined ? { revision } : { revision, error: lastError }),
  };
}
