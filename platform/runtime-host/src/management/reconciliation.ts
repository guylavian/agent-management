import type { AgentDeploymentOverlay, AgentLifecycle } from "@sre/config";

/**
 * THE COMBINED MANAGEMENT VIEW.
 *
 * Git is desired state. Argo CD and the running pod are actual state. The
 * console needs both, separately, and it needs them to stay separate: an Agent
 * that is merged but not synced, or synced but not ready, or ready but not
 * routable, are four different problems with four different fixes, and a single
 * green/red dot collapses all of them into "it doesn't work".
 *
 *     git     — is the desired state in the repository, and does it enable this?
 *     argo    — has the cluster been reconciled to it?
 *     runtime — is the pod answering?
 *     manager — is it in the effective routing catalog?
 *
 * NOTHING HERE IS FABRICATED. A signal this deployment cannot observe reports
 * `unknown` with the reason it cannot. The previous console reported an
 * unprobed agent as reachable, which is the specific failure this replaces:
 * an invented green is worse than an honest question mark, because only one of
 * them makes someone go and look.
 */
export type SignalState = "ok" | "pending" | "degraded" | "unknown";

export interface Signal {
  state: SignalState;
  /** always present: a state with no explanation is not diagnosable */
  detail: string;
}

/**
 * THE AGENT LIFECYCLE.
 *
 *   draft ──▶ pending-merge ──▶ reconciling ──▶ active
 *                                   │              │
 *                                   ├──▶ degraded ─┤   (actual state failed)
 *                                   └──▶ failed        (desired state invalid)
 *
 *   active ──▶ reconciling ──▶ disabled              (and back on re-enable)
 *
 * `draft` and `pending-merge` are the two states that exist BEFORE the change
 * is in the repository, and neither is invented:
 *
 *  - `draft` is an Agent document that IS merged but whose own `lifecycle` says
 *    it is not meant to run yet. It is desired state, read like any other.
 *  - `pending-merge` cannot be seen from here at all — this runtime reads the
 *    repository as Argo synced it, so an unmerged branch does not exist to it.
 *    It is contributed by the management plane, which holds the Git credential
 *    and can ask the provider for open proposals. The status lives in this one
 *    union so that both planes speak the same vocabulary.
 */
export type AgentStatus =
  | "draft"
  | "pending-merge"
  | "reconciling"
  | "active"
  | "disabled"
  | "degraded"
  | "failed";

export interface AgentReconciliation {
  status: AgentStatus;
  git: Signal;
  argo: Signal;
  runtime: Signal;
  manager: Signal;
}

/** Argo CD, when the deployment has one wired. */
export interface DeploymentStatusSource {
  status(agentId: string): Promise<Signal>;
}

/** A liveness probe against the agent's own Service endpoint. */
export interface RuntimeProbe {
  status(agentId: string, endpoint: string): Promise<Signal>;
}

export function unobserved(reason: string): Signal {
  return { state: "unknown", detail: reason };
}

/**
 * Fold the four signals into one status.
 *
 * Order matters and is deliberate:
 *
 *  1. A config-load failure is FAILED even if the pod from the previous
 *     revision is still happily serving — the desired state is broken and that
 *     is the thing an operator has to fix.
 *  2. DRAFT is a statement about the Agent, not about the cluster. It is
 *     distinct from DISABLED: nothing was ever turned off, and nobody should go
 *     looking for what broke.
 *  3. A DISABLE IS A RECONCILIATION, not an instant. While Argo still holds the
 *     Application, the workload is being pruned and the honest state is
 *     `reconciling`; `disabled` means desired state and actual state agree.
 *  4. Any observed failure is DEGRADED — and it stays VISIBLE. An Agent that
 *     merged and then failed to deploy must never drop off the page, which is
 *     what listing from the runtime registry used to do.
 *  5. A pod that is not answering WHILE ARGO IS STILL SYNCING is reconciling,
 *     not degraded. Every new agent goes through that window, and calling it
 *     degraded would mean every successful onboarding flashed red first.
 *  6. ACTIVE requires positive evidence: enabled in Git, routable, and not
 *     contradicted by anything observed. An `unknown` runtime does not block
 *     it — a deployment with no probe wired would otherwise never show a single
 *     healthy agent — but an observed-not-ready one does.
 */
export function foldStatus(signals: {
  git: Signal;
  argo: Signal;
  runtime: Signal;
  manager: Signal;
  /** the Agent document has never been declared ready to run */
  draft: boolean;
  /** desired state says this Agent is deliberately off */
  disabled: boolean;
}): AgentStatus {
  if (signals.git.state === "degraded") return "failed";
  if (signals.draft) return "draft";
  if (signals.disabled) {
    // Argo still reporting the Application means the prune has not finished.
    // Calling that DISABLED would tell an operator the workload is gone while
    // it is still serving, which is the one wrong answer that matters here.
    return signals.argo.state === "ok" || signals.argo.state === "pending" ? "reconciling" : "disabled";
  }
  const stillSyncing = signals.argo.state === "pending";
  const observed = [signals.argo, ...(stillSyncing ? [] : [signals.runtime])];
  if (observed.some((signal) => signal.state === "degraded")) return "degraded";
  if (signals.git.state === "ok" && signals.manager.state === "ok" && signals.argo.state !== "pending" && signals.runtime.state !== "pending") {
    return "active";
  }
  return "reconciling";
}

export interface ReconcileInput {
  agentId: string;
  /** straight from the Agent document; `draft` and `disabled` are not the same state */
  lifecycle: AgentLifecycle;
  overlay?: AgentDeploymentOverlay;
  /**
   * Whether the Manager's EFFECTIVE catalog currently offers this Agent.
   *
   * Supplied by the caller and never recomputed here, because the caller reads
   * the same catalog object the orchestrator routes from. A second derivation
   * would be a second opinion, and the console showing "Routable" for something
   * the router refuses is precisely the bug this whole view exists to end.
   */
  routable: boolean;
  environment: string;
  /** set when the most recent desired-state reload failed to validate */
  loadError?: string;
  argo: Signal;
  runtime: Signal;
}

export function reconcile(input: ReconcileInput): AgentReconciliation {
  const git = gitSignal(input);
  const draft = input.loadError === undefined && input.lifecycle === "draft";
  const disabled = input.loadError === undefined && !draft && (input.lifecycle !== "active" || input.overlay?.enabled === false);
  const manager: Signal = input.routable
    ? { state: "ok", detail: `in the Manager's effective catalog for ${input.environment}` }
    : {
      state: "pending",
      detail: git.state === "ok"
        // desired state is fine, so the gap is availability: the catalog admits
        // an Agent only once something has observed it answering
        ? `not in the Manager's effective catalog for ${input.environment}: ${input.runtime.detail}`
        : `not routable: ${git.detail}`,
    };
  const signals = { git, argo: input.argo, runtime: input.runtime, manager };
  return { status: foldStatus({ ...signals, draft, disabled }), ...signals };
}

/**
 * Desired state only. "Merged" is implicit — this process reads the repository
 * as Argo has synced it onto disk, so a document being here IS the evidence the
 * pull request merged.
 */
function gitSignal(input: ReconcileInput): Signal {
  if (input.loadError !== undefined) {
    return { state: "degraded", detail: `configuration does not load: ${input.loadError}` };
  }
  if (input.lifecycle === "draft") {
    return { state: "pending", detail: "present in Git as a draft: the Agent document's lifecycle is not active yet" };
  }
  if (input.lifecycle !== "active") {
    return { state: "pending", detail: `disabled: the Agent document's lifecycle is "${input.lifecycle}"` };
  }
  if (input.overlay === undefined) {
    return { state: "pending", detail: `merged, but ${input.environment} has no deployment overlay for this Agent` };
  }
  if (!input.overlay.enabled) {
    return { state: "pending", detail: `disabled: the ${input.environment} deployment overlay sets enabled: false` };
  }
  return { state: "ok", detail: `merged and enabled in ${input.environment}` };
}

/**
 * Argo CD's own view, read through its API.
 *
 * One Application per rendered Agent, named by the same convention the
 * ApplicationSet template uses — so this asks about the object Argo actually
 * created rather than guessing at a label selector.
 */
export class ArgoCdStatusSource implements DeploymentStatusSource {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #appTemplate: string;
  readonly #fetch: typeof fetch;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, { at: number; signal: Signal }>();

  constructor(options: {
    baseUrl: string;
    token: string;
    /** `{agentId}` is substituted; defaults to the ApplicationSet's own naming */
    appTemplate?: string;
    ttlMs?: number;
    fetchImplementation?: typeof fetch;
    now?: () => number;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.#token = options.token;
    this.#appTemplate = options.appTemplate ?? "sre-agent-{agentId}";
    this.#ttlMs = options.ttlMs ?? 10_000;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#now = options.now ?? (() => Date.now());
  }

  async status(agentId: string): Promise<Signal> {
    const cached = this.#cache.get(agentId);
    if (cached && this.#now() - cached.at < this.#ttlMs) return cached.signal;
    const signal = await this.#read(agentId);
    this.#cache.set(agentId, { at: this.#now(), signal });
    return signal;
  }

  async #read(agentId: string): Promise<Signal> {
    const app = this.#appTemplate.replaceAll("{agentId}", agentId);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/v1/applications/${encodeURIComponent(app)}`, {
        headers: { authorization: `Bearer ${this.#token}` },
      });
    } catch {
      // never echo the transport error: it can disclose internal endpoints
      return unobserved("Argo CD could not be reached");
    }
    // an Application that does not exist yet is the normal state seconds after
    // a merge — the ApplicationSet has not generated it. That is PENDING, and
    // saying "degraded" here would make every new agent look broken on arrival.
    if (response.status === 404) return { state: "pending", detail: `no Argo CD Application ${app} yet` };
    if (!response.ok) return unobserved(`Argo CD answered ${response.status}`);
    const body = (await response.json().catch(() => ({}))) as {
      status?: { sync?: { status?: string }; health?: { status?: string } };
    };
    const sync = body.status?.sync?.status;
    const health = body.status?.health?.status;
    if (sync === undefined && health === undefined) return unobserved(`Argo CD reported no status for ${app}`);
    const detail = `sync ${sync ?? "unknown"}, health ${health ?? "unknown"}`;
    if (health === "Degraded" || health === "Missing") return { state: "degraded", detail };
    if (sync === "Synced" && health === "Healthy") return { state: "ok", detail };
    return { state: "pending", detail };
  }
}

/**
 * Readiness, asked of the agent's own Service.
 *
 * The endpoint comes from the effective catalog, which is the same address the
 * Manager would dispatch to — so a green here means the route the router would
 * take is the route that answered.
 */
export class HttpRuntimeProbe implements RuntimeProbe {
  readonly #timeoutMs: number;
  readonly #ttlMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, { at: number; signal: Signal }>();

  constructor(options: { timeoutMs?: number; ttlMs?: number; fetchImplementation?: typeof fetch; now?: () => number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? 1_500;
    this.#ttlMs = options.ttlMs ?? 10_000;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#now = options.now ?? (() => Date.now());
  }

  async status(agentId: string, endpoint: string): Promise<Signal> {
    const cached = this.#cache.get(agentId);
    if (cached && this.#now() - cached.at < this.#ttlMs) return cached.signal;
    const signal = await this.#read(endpoint);
    this.#cache.set(agentId, { at: this.#now(), signal });
    return signal;
  }

  async #read(endpoint: string): Promise<Signal> {
    const controller = new AbortController();
    // a management page must not hang on an agent that is not answering; a
    // timeout IS the answer in that case
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${endpoint.replace(/\/$/u, "")}/health/ready`, { signal: controller.signal });
      if (response.ok) return { state: "ok", detail: "the pod answered /health/ready" };
      return { state: "degraded", detail: `the pod answered ${response.status} on /health/ready` };
    } catch {
      return { state: "degraded", detail: "the pod did not answer /health/ready" };
    } finally {
      clearTimeout(timer);
    }
  }
}
