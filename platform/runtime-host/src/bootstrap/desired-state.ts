import { readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import {
  loadAgentRegistry,
  loadDeploymentEnvironment,
  loadEffectiveAgentCatalog,
  type AgentDeploymentOverlay,
  type AgentRegistry,
  type LoadOptions,
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
    try {
      this.#snapshot = { ...this.#load(), revision, loadedAt: new Date(now).toISOString() };
    } catch (error) {
      // last good state, plus the reason the new one was refused
      this.#snapshot = { ...this.#snapshot, revision, error: describe(error) };
    }
    return this.#snapshot;
  }
}

/**
 * Build the source from the paths a runtime already knows. Both halves come
 * from the same call, so a snapshot can never mix an old registry with a new
 * deployment overlay.
 */
export function desiredStateSource(options: DesiredStateOptions, hooks: { now?: () => number } = {}): DesiredStateSource {
  const base = options.baseDir ?? process.cwd();
  const load = (): Omit<DesiredState, "revision" | "loadedAt"> => {
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
