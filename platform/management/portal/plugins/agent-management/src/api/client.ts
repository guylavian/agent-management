import { useEffect, useState } from 'react';
import { useApi, fetchApiRef } from '@backstage/frontend-plugin-api';
import useAsync from 'react-use/esm/useAsync';
import type {
  AgentDetail,
  AgentDraft,
  AgentSummary,
  ChangePreview,
  ManagerDetail,
  ManagerDraft,
  McpServer,
  PermissionMatrix,
  PromptAssistRequest,
  RunDetail,
  RunSummary,
} from './types';

/**
 * Thin client over the agent-management backend plugin.
 *
 * A 501 means the deployment has no runtime management API wired. That is
 * surfaced to the caller as `notConfigured` so pages can say so, rather than
 * rendering an empty table that looks like "you have no agents".
 */
export class NotConfiguredError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'NotConfiguredError';
  }
}

function useFetch() {
  const { fetch } = useApi(fetchApiRef);
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`plugin://agent-management${path}`, init);
    if (response.status === 501) {
      throw new NotConfiguredError(((await response.json()) as { reason?: string }).reason ?? 'not configured');
    }
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  };
}

/**
 * How often views that track a RECONCILING resource re-fetch.
 *
 * Merging a pull request starts a sequence nobody drives from this browser:
 * Argo syncs, a pod starts, the Manager's catalog picks the Agent up. Without a
 * poll the console showed the state at page load and stayed there, so the only
 * way to see a merge take effect was to know to press reload — and an operator
 * watching a deployment that has silently failed will reload for a while before
 * they start to doubt the page instead of the deployment.
 *
 * Seven seconds is slower than the runtime's own desired-state revalidation, so
 * a poll costs a few `stat` calls rather than a re-validation of every Agent.
 */
export const RECONCILE_POLL_MS = 7_000;

/**
 * `useAsync` that re-runs on a timer.
 *
 * The previous value stays on screen while the next request is in flight, so a
 * polling table does not flash its loading state every few seconds. A tab in
 * the background stops polling: `document.hidden` is checked on each tick
 * rather than by tearing the interval down, so returning to the tab refreshes
 * on the next tick instead of needing a remount.
 */
export function usePolled<T>(load: () => Promise<T>, deps: unknown[], intervalMs = RECONCILE_POLL_MS) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) setTick(current => current + 1);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  const state = useAsync(load, [...deps, tick]);
  const [last, setLast] = useState<T | undefined>(undefined);
  useEffect(() => {
    if (state.value !== undefined) setLast(state.value);
  }, [state.value]);
  const value = state.value ?? last;
  const hasValue = value !== undefined;
  return {
    ...state,
    value,
    // only the FIRST load is a loading state; a refresh must not blank the page
    loading: state.loading && !hasValue,
    refreshing: state.loading && hasValue,
    /*
     * A failed REFRESH is not a failed page.
     *
     * Polling turns a single dropped request into an error state every few
     * seconds, so a console that surfaced it the same way would replace a
     * working table with a stack trace because one poll timed out. The error is
     * still reported — as `refreshError`, for a line beside the data rather
     * than instead of it — and only becomes the page's error when there has
     * never been anything to show.
     */
    error: hasValue ? undefined : state.error,
    refreshError: hasValue ? state.error : undefined,
  };
}

/**
 * The Agents directory. Polled, because an Agent that merged a moment ago has
 * to appear on its own — the whole point of the flow is that merging is enough.
 */
export function useAgents() {
  const request = useFetch();
  return usePolled(async () => (await request<{ agents: AgentSummary[]; revision: string; configError?: string; proposalsError?: string }>('/agents')), []);
}

/** No id means nothing to fetch — the create wizard shares a component with the edit wizard. */
export function useAgent(id: string) {
  const request = useFetch();
  return usePolled(async () => (id === '' ? undefined : request<AgentDetail>(`/agents/${encodeURIComponent(id)}`)), [id]);
}

/** The Manager is its own endpoint because it is its own document type. */
export function useManager() {
  const request = useFetch();
  // polled too: the routing table is DERIVED, so it changes when an Agent is
  // enabled or disabled without anything on this page being edited
  return usePolled(async () => request<ManagerDetail>('/manager'), []);
}

export function useAgentHealth(id: string) {
  const request = useFetch();
  return usePolled(async () => request<Record<string, unknown>>(`/agents/${encodeURIComponent(id)}/health`), [id]);
}

export function useAgentMetrics(id: string) {
  const request = useFetch();
  return useAsync(async () => request<Record<string, unknown>>(`/agents/${encodeURIComponent(id)}/metrics`), [id]);
}

export function useMcpServers() {
  const request = useFetch();
  return useAsync(async () => (await request<{ servers: McpServer[] }>('/mcp-servers')).servers, []);
}

export function usePermissionMatrix() {
  const request = useFetch();
  return useAsync(async () => request<PermissionMatrix>('/permissions'), []);
}

export function useRuns() {
  const request = useFetch();
  return usePolled(async () => (await request<{ runs: RunSummary[] }>('/runs')).runs, []);
}

export function useRun(id: string) {
  const request = useFetch();
  return useAsync(async () => request<RunDetail>(`/runs/${encodeURIComponent(id)}`), [id]);
}

/**
 * Read a run's trace with the console-assistance model.
 *
 * Not a `useAsync`: a diagnosis costs a model call, so it happens when an
 * operator asks for one rather than on every visit to the page.
 */
export function useRunDiagnosis() {
  const request = useFetch();
  return (id: string) =>
    request<{ diagnosis: string }>(`/runs/${encodeURIComponent(id)}/diagnose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
}

export function useEvaluations() {
  const request = useFetch();
  return useAsync(async () => request<Record<string, unknown>>('/evaluations'), []);
}

/** Imperative actions used by the Create Agent wizard. */
export function useAgentActions() {
  const request = useFetch();
  return {
    preview: (draft: AgentDraft) =>
      request<ChangePreview>('/agents/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      }),
    createPullRequest: (draft: AgentDraft) =>
      request<{ url: string; status: string; reason?: string; effects: string[] }>('/agents/change', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      }),
    /** Render the Manager change-set. Pure; changes nothing. */
    previewManager: (draft: ManagerDraft) =>
      request<ChangePreview>('/manager/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      }),
    /** Open the pull request for a Manager change. */
    createManagerPullRequest: (draft: ManagerDraft) =>
      request<{ url: string; status: string; reason?: string; effects: string[] }>('/manager/change', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      }),
    /**
     * Draft a system prompt from the form as it stands. Returns text only —
     * nothing is saved and no pull request is opened by this call.
     */
    draftPrompt: (context: PromptAssistRequest) =>
      request<{ prompt: string }>('/prompt-assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(context),
      }),
    /** The curated built-in catalog, served by the runtime so it is not duplicated here. */
    avatarIcons: () => request<{ icons: Array<{ id: string; label: string; asset: string; fit: 'cover' | 'contain' }> }>('/avatar/icons'),
    /**
     * Check an upload before the operator reaches the review step, using the
     * SAME validation that will gate the change-set. A check in the browser
     * would be a second opinion, and not the one that counts.
     */
    validateAvatar: (upload: string) =>
      request<{ format: string; width: number; height: number; bytes: number }>('/avatar/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ upload }),
      }),
    /** Propose a prompt edit. Touches one file; the Agent document is untouched. */
    proposePrompt: (id: string, prompt: string) =>
      request<{ url?: string; status: string; reason?: string; effects: string[]; branch: string }>(
        `/agents/${encodeURIComponent(id)}/prompt/change`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) },
      ),
  };
}
