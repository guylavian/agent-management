import { useApi, fetchApiRef } from '@backstage/frontend-plugin-api';
import useAsync from 'react-use/esm/useAsync';
import type {
  AgentDetail,
  AgentDraft,
  AgentSummary,
  ChangePreview,
  McpServer,
  PermissionMatrix,
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

export function useAgents() {
  const request = useFetch();
  return useAsync(async () => (await request<{ agents: AgentSummary[] }>('/agents')).agents, []);
}

export function useAgent(id: string) {
  const request = useFetch();
  return useAsync(async () => request<AgentDetail>(`/agents/${encodeURIComponent(id)}`), [id]);
}

export function useAgentHealth(id: string) {
  const request = useFetch();
  return useAsync(async () => request<Record<string, unknown>>(`/agents/${encodeURIComponent(id)}/health`), [id]);
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
  return useAsync(async () => (await request<{ runs: RunSummary[] }>('/runs')).runs, []);
}

export function useRun(id: string) {
  const request = useFetch();
  return useAsync(async () => request<RunDetail>(`/runs/${encodeURIComponent(id)}`), [id]);
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
    /** Propose a prompt edit. Touches one file; the Agent document is untouched. */
    proposePrompt: (id: string, prompt: string) =>
      request<{ url?: string; status: string; reason?: string; effects: string[]; branch: string }>(
        `/agents/${encodeURIComponent(id)}/prompt/change`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) },
      ),
  };
}
