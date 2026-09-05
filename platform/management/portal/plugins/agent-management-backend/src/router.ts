import type { HttpAuthService, PermissionsService } from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { NotAllowedError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import type { BasicPermission } from '@backstage/plugin-permission-common';
import {
  agentAccessEditPermission,
  agentCreatePrPermission,
  agentReadPermission,
  evaluationReadPermission,
  mcpReadPermission,
  runReadPermission,
} from './permissions';
import { runtimeManagementClientRef } from './services/RuntimeManagementClient';
import type { gitOpsPublisherRef } from './services/GitOpsPublisher';
import { InMemoryRequestStore, newRequestId, projectRequest, scrubMessage, summarise, type ProjectionInput, type RequestRecord, type RequestStore, type RequestType, type RuntimeSnapshot } from './services/RequestStore';
import type { AgentDraft, AgentReconciliation, AgentSummary, ChangePreview } from './api/generated-types';

/**
 * Management operations for the portal.
 *
 * Every route is permission-checked for the HUMAN performing it, then proxied
 * to the runtime's management API. Backstage authorizing a human to edit an
 * Agent says nothing about what that Agent may call — those decisions stay in
 * the runtime and are re-evaluated there on every tool call (TDD §41).
 */
export async function createRouter({
  httpAuth,
  permissions,
  runtime,
  gitops,
  requests = new InMemoryRequestStore(),
  now = () => new Date().toISOString(),
}: {
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  runtime: typeof runtimeManagementClientRef.T;
  gitops: typeof gitOpsPublisherRef.T;
  requests?: RequestStore;
  now?: () => string;
}): Promise<express.Router> {
  const router = Router();
  /*
   * An avatar is up to 1 MB, which is ~1.37 MB once base64-encoded — well past
   * the 100 KB default, so an upload would have been rejected by the body
   * parser before any of the validation ran. The ceiling is deliberately just
   * above what the runtime accepts, so the definitive answer still comes from
   * the runtime rather than from a limit here.
   */
  router.use(express.json({ limit: '2mb' }));

  const requirePermission = async (request: express.Request, permission: BasicPermission): Promise<string> => {
    const credentials = await httpAuth.credentials(request, { allow: ['user'] });
    const [decision] = await permissions.authorize([{ permission }], { credentials });
    if (decision?.result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError(`Not allowed to perform ${permission.name}`);
    }
    // the requester, for the Requests page: an entity ref, never a token
    const principal = credentials.principal as { userEntityRef?: string };
    return principal.userEntityRef ?? 'unknown';
  };

  // when no runtime is configured, say so instead of rendering an empty console
  const proxyGet = (path: string, permission: BasicPermission, runtimePath: string) => {
    router.get(path, async (request, response) => {
      await requirePermission(request, permission);
      if (!runtime.configured) {
        response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
        return;
      }
      const resolved = runtimePath.replace(/:(\w+)/gu, (_match, key: string) =>
        encodeURIComponent(String(request.params[key])),
      );
      response.json(await runtime.get(resolved));
    });
  };

  /**
   * THE AGENT INVENTORY, from both planes.
   *
   * The runtime contributes everything in Git — desired state joined to Argo
   * and pod status. This backend contributes the one state the runtime cannot
   * see: an Agent whose pull request is OPEN. The runtime reads the repository
   * as Argo synced it, so an unmerged branch does not exist to it, and
   * "Pending merge" was previously a badge that lived only on the page that had
   * just created the proposal and vanished on navigation.
   *
   * The join is by agent id, and the runtime always wins: once an Agent is
   * merged it has real desired state, and a stale open branch for it is an
   * update in flight rather than a second copy of the Agent.
   */
  router.get('/agents', async (request, response) => {
    await requirePermission(request, agentReadPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const listed = await runtime.get<{ agents: AgentSummary[] }>('/management/agents');
    const known = new Set(listed.agents.map(agent => agent.id));
    /*
     * Best-effort, and it must NEVER fail the page: the inventory that matters
     * is the merged one, and losing the whole Agents view because the Git
     * provider rate-limited would be a far worse outcome than not showing a
     * pending row. The failure is reported alongside the data.
     */
    const [proposals] = await Promise.allSettled([gitops.listProposals()]);
    const pending = proposals.status === 'fulfilled'
      ? proposals.value.filter(proposal => proposal.kind === 'add' && !known.has(proposal.agentId))
      : [];
    response.json({
      ...listed,
      ...(proposals.status === 'rejected' ? { proposalsError: 'open pull requests could not be listed' } : {}),
      agents: [...listed.agents, ...pending.map(proposal => pendingAgent(proposal.agentId, proposal.title, proposal.url))],
    });
  });
  // not /agents/manager: the Manager is a different document type, and serving
  // it there would mean inventing the identity and access fields it has none of
  proxyGet('/manager', agentReadPermission, '/management/manager');
  proxyGet('/agents/:id', agentReadPermission, '/management/agents/:id');
  proxyGet('/agents/:id/health', agentReadPermission, '/management/agents/:id/health');
  proxyGet('/agents/:id/metrics', agentReadPermission, '/management/agents/:id/metrics');
  proxyGet('/mcp-servers', mcpReadPermission, '/management/mcp-servers');
  proxyGet('/permissions', agentReadPermission, '/management/permissions');
  proxyGet('/runs', runReadPermission, '/management/runs');
  proxyGet('/runs/:id', runReadPermission, '/management/runs/:id');
  proxyGet('/evaluations', evaluationReadPermission, '/management/evaluations');

  /** Pure preview: validates the draft and renders canonical YAML. Changes nothing. */
  /**
   * Reading a run's trace with the console-assistance model. Requires only the
   * permission that already lets an operator READ the run: the diagnosis says
   * nothing the trace does not, and changes nothing.
   */
  router.post('/runs/:id/diagnose', async (request, response) => {
    await requirePermission(request, runReadPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const result = await runtime.post(`/management/runs/${encodeURIComponent(request.params.id)}/diagnose`, {});
    response.status(result.status).json(result.body);
  });

  router.post('/agents/preview', async (request, response) => {
    await requirePermission(request, agentAccessEditPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const result = await runtime.post('/management/agents/preview', request.body);
    response.status(result.status).json(result.body);
  });

  /**
   * Opens the pull request. This is the only way an Agent changes — there is no
   * deploy route, and there is no runtime endpoint that could add one.
   *
   * The runtime RENDERS the change-set, because it owns the canonical schema
   * and must load the result at startup. The management plane PUBLISHES it,
   * because it owns the Git credential. The execution plane therefore cannot
   * write a change to its own policy, and holds no token that would let it.
   */
  router.post('/agents/change', async (request, response) => {
    const requestedBy = await requirePermission(request, agentCreatePrPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const draft = request.body as AgentDraft;
    /*
     * The Request is recorded BEFORE anything is attempted, so a change that
     * fails to render or to publish still leaves a trace saying where it
     * stopped — the same reason a run records a refused tool call.
     */
    const record: RequestRecord = {
      id: newRequestId(),
      agentId: draft.name,
      type: await requestType(draft),
      requestedBy,
      createdAt: now(),
      branch: '',
      effects: [],
    };
    await requests.record(record);

    const rendered = await runtime.post<ChangePreview>('/management/agents/preview', request.body);
    if (rendered.status !== 200) {
      const body = rendered.body as unknown as { message?: string; issues?: string[] };
      await requests.update(record.id, { preparedAt: now(), prepareError: scrubMessage([body.message, ...(body.issues ?? [])].filter(Boolean).join('; ') || `preview refused (${rendered.status})`) });
      response.status(rendered.status).json({ ...(rendered.body as object), requestId: record.id });
      return;
    }
    const preview = rendered.body;
    await requests.update(record.id, { preparedAt: now(), branch: preview.branch, effects: preview.effects, ...(preview.diff ? { diff: preview.diff } : {}) });
    if (!gitops.configured) {
      const outcome = await gitops.createPullRequest({ branch: preview.branch, title: preview.title, body: preview.body, files: preview.files });
      await requests.update(record.id, { notConfigured: outcome.reason ?? 'no Git provider is configured' });
      response.status(501).json({ status: 'not-configured', reason: outcome.reason, branch: preview.branch, effects: preview.effects, requestId: record.id });
      return;
    }
    let outcome;
    try {
      outcome = await gitops.createPullRequest({ branch: preview.branch, title: preview.title, body: preview.body, files: preview.files });
    } catch (error) {
      // the provider's message names a branch or a status, not a credential —
      // and it is bounded, the same ceiling the runtime puts on a node's detail
      await requests.update(record.id, { publishedAt: now(), publishError: scrubMessage((error instanceof Error ? error.message : 'the pull request could not be opened').slice(0, 500)) });
      throw error;
    }
    if (outcome.status === 'created' && outcome.number !== undefined) {
      await requests.update(record.id, { publishedAt: now(), pullRequest: { number: outcome.number, ...(outcome.url ? { url: outcome.url } : {}) } });
    } else {
      await requests.update(record.id, { publishedAt: now(), publishError: outcome.reason ?? 'the provider returned no pull request number' });
    }
    response.status(outcome.status === 'created' ? 201 : 501).json({ ...outcome, branch: preview.branch, effects: preview.effects, requestId: record.id });
  });

  /**
   * Remove an Agent. The runtime enumerates the files it owns and refuses when
   * another Agent still depends on it; this plane opens the pull request that
   * deletes them. Tracked as a Request like every other change.
   */
  router.post('/agents/:id/delete', async (request, response) => {
    const requestedBy = await requirePermission(request, agentCreatePrPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const agentId = request.params.id;
    const record: RequestRecord = { id: newRequestId(), agentId, type: 'delete', requestedBy, createdAt: now(), branch: '', effects: [] };
    await requests.record(record);
    const rendered = await runtime.post<ChangePreview>(`/management/agents/${encodeURIComponent(agentId)}/delete/preview`, {});
    if (rendered.status !== 200) {
      const body = rendered.body as unknown as { message?: string; issues?: string[] };
      await requests.update(record.id, { preparedAt: now(), prepareError: scrubMessage([body.message, ...(body.issues ?? [])].filter(Boolean).join('; ') || `preview refused (${rendered.status})`) });
      response.status(rendered.status).json({ ...(rendered.body as object), requestId: record.id });
      return;
    }
    const preview = rendered.body;
    await requests.update(record.id, { preparedAt: now(), branch: preview.branch, effects: preview.effects, ...(preview.diff ? { diff: preview.diff } : {}) });
    let outcome;
    try {
      outcome = await gitops.createPullRequest({ branch: preview.branch, title: preview.title, body: preview.body, files: preview.files });
    } catch (error) {
      await requests.update(record.id, { publishedAt: now(), publishError: scrubMessage((error instanceof Error ? error.message : 'the pull request could not be opened').slice(0, 500)) });
      throw error;
    }
    if (outcome.status === 'created' && outcome.number !== undefined) {
      await requests.update(record.id, { publishedAt: now(), pullRequest: { number: outcome.number, ...(outcome.url ? { url: outcome.url } : {}) } });
    } else {
      await requests.update(record.id, { publishedAt: now(), ...(outcome.status === 'not-configured' ? { notConfigured: outcome.reason ?? 'no Git provider is configured' } : { publishError: outcome.reason ?? 'the provider returned no pull request number' }) });
    }
    response.status(outcome.status === 'created' ? 201 : 501).json({ ...outcome, branch: preview.branch, effects: preview.effects, requestId: record.id });
  });

  /**
   * Which kind of change this is, from what the runtime already has.
   *
   * Enable and disable are edits whose only meaningful difference is the
   * lifecycle flip, and the console tracks them as their own type because the
   * question an operator asks afterwards ("is it off yet?") is different.
   */
  async function requestType(draft: AgentDraft): Promise<RequestType> {
    const existing = await runtime.get<{ lifecycle?: string }>(`/management/agents/${encodeURIComponent(draft.name)}`).catch(() => undefined);
    if (existing?.lifecycle === undefined) return 'create';
    const wasActive = existing.lifecycle === 'active';
    const willBeActive = (draft.lifecycle ?? 'draft') === 'active';
    if (wasActive && !willBeActive) return 'disable';
    if (!wasActive && willBeActive) return 'enable';
    return 'edit';
  }

  /**
   * MANAGEMENT REQUESTS, projected onto live state on every read.
   *
   * Pre-merge the provider is the source of truth for the pull request; after
   * the merge the runtime's reconciliation is. Neither is cached beyond a
   * terminal provider answer (merged/declined never changes again), so the
   * page polls this and sees transitions without anyone pushing them.
   */
  async function project(records: RequestRecord[]) {
    const snapshot: ProjectionInput['runtime'] = await runtime
      .get<RuntimeSnapshot>('/management/agents')
      .then(value => ({ loadedAt: value.loadedAt, agents: value.agents, ...(value.configError ? { configError: value.configError } : {}) }))
      .catch((error: Error) => ({ error: error.message }));
    const states = await Promise.allSettled(
      records.map(async (record): Promise<ProjectionInput['pullRequest']> => {
        if (record.pullRequest === undefined) return undefined;
        const cached = record.pullRequestState;
        if (cached !== undefined && cached.state !== 'open') return cached;
        const fresh = await gitops.pullRequestState(record.pullRequest.number);
        await requests.update(record.id, { pullRequestState: { ...fresh, observedAt: now() } });
        return fresh;
      }),
    );
    return records.map((record, index) => {
      const state = states[index];
      const pullRequest = state?.status === 'fulfilled'
        ? state.value
        : record.pullRequestState ?? { error: 'the Git provider could not be reached' };
      return projectRequest({ record, pullRequest, runtime: snapshot });
    });
  }

  router.get('/requests', async (request, response) => {
    await requirePermission(request, agentReadPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    response.json({ requests: (await project(await requests.list())).map(summarise) });
  });

  router.get('/requests/:id', async (request, response) => {
    await requirePermission(request, agentReadPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const record = await requests.get(request.params.id);
    if (record === undefined) {
      response.status(404).json({ code: 'not_found', message: 'request not found' });
      return;
    }
    const [detail] = await project([record]);
    response.json(detail);
  });

  /**
   * Propose a prompt edit. Same split as /agents/change: the runtime RENDERS
   * the change-set because it owns the schema, the management plane PUBLISHES
   * it because it owns the Git credential. Only the prompt file is touched.
   */
  router.post('/agents/:id/prompt/change', async (request, response) => {
    await requirePermission(request, agentCreatePrPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const rendered = await runtime.post<ChangePreview>(`/management/agents/${encodeURIComponent(request.params.id)}/prompt/preview`, request.body);
    if (rendered.status !== 200) {
      response.status(rendered.status).json(rendered.body);
      return;
    }
    const preview = rendered.body;
    const outcome = await gitops.createPullRequest({ branch: preview.branch, title: preview.title, body: preview.body, files: preview.files });
    response.status(outcome.status === 'created' ? 201 : 501).json({ ...outcome, branch: preview.branch, effects: preview.effects });
  });

  /**
   * Avatar assets. The image itself is served from Git through the runtime, so
   * the browser never holds a base64 blob and no third party learns which
   * agents exist.
   */
  proxyGet('/avatar/icons', agentReadPermission, '/management/avatar/icons');

  router.get('/agents/:id/avatar', async (request, response) => {
    await requirePermission(request, agentReadPermission);
    if (!runtime.configured) { response.status(404).end(); return; }
    const image = await runtime.getBinary(`/management/agents/${encodeURIComponent(request.params.id)}/avatar`);
    // 404 rather than an error page: an agent without an avatar is normal, and
    // the console falls back to initials on a failed image load
    if (image === undefined) { response.status(404).end(); return; }
    response.setHeader('content-type', image.contentType);
    response.setHeader('cache-control', 'private, max-age=300');
    response.send(image.bytes);
  });

  /** Validate an upload without committing it, using the runtime's own checks. */
  router.post('/avatar/validate', async (request, response) => {
    await requirePermission(request, agentAccessEditPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const result = await runtime.post('/management/avatar/validate', request.body);
    response.status(result.status).json(result.body);
  });

  /**
   * Draft a system prompt. The browser never reaches a model directly: the
   * request goes portal → this backend → the runtime → the environment's bound
   * `prompt-assist` profile, so an air-gapped deployment resolves it to an
   * internal endpoint with nothing in the browser changing.
   *
   * Gated on the same permission as editing access, because drafting text that
   * an operator will paste into a prompt is an authoring action.
   */
  router.post('/prompt-assist', async (request, response) => {
    await requirePermission(request, agentAccessEditPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const result = await runtime.post('/management/prompt-assist', request.body);
    response.status(result.status).json(result.body);
  });

  /**
   * The Manager. Same split as every other change: the runtime RENDERS because
   * it owns the schema, the management plane PUBLISHES because it owns the Git
   * credential. Editing the routing table decides which specialists a request
   * can reach at all, so it is gated on the same permissions as agent access —
   * and it is still a pull request, never a live mutation.
   */
  router.post('/manager/preview', async (request, response) => {
    await requirePermission(request, agentAccessEditPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const result = await runtime.post('/management/manager/preview', request.body);
    response.status(result.status).json(result.body);
  });

  router.post('/manager/change', async (request, response) => {
    await requirePermission(request, agentCreatePrPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const rendered = await runtime.post<ChangePreview>('/management/manager/preview', request.body);
    if (rendered.status !== 200) {
      response.status(rendered.status).json(rendered.body);
      return;
    }
    const preview = rendered.body;
    const outcome = await gitops.createPullRequest({ branch: preview.branch, title: preview.title, body: preview.body, files: preview.files });
    response.status(outcome.status === 'created' ? 201 : 501).json({ ...outcome, branch: preview.branch, effects: preview.effects });
  });

  return router;
}

/**
 * A row for an Agent that exists only as an open pull request.
 *
 * Every field the console would show about a real Agent is DELIBERATELY empty
 * or zero rather than parsed out of the proposal's diff: nothing about it is
 * true yet, the schema that would validate it lives in the runtime, and a row
 * that displayed a tool count from an unmerged branch would be showing access
 * nobody has approved. The row exists to say "this is on its way", with a link.
 */
function pendingAgent(agentId: string, title: string, url?: string): AgentSummary {
  const reconciliation: AgentReconciliation = {
    status: 'pending-merge',
    git: { state: 'pending', detail: url ? `proposed in ${url}` : 'proposed, not yet merged' },
    argo: { state: 'unknown', detail: 'nothing is deployed until the pull request merges' },
    runtime: { state: 'unknown', detail: 'nothing is running until the pull request merges' },
    manager: { state: 'pending', detail: 'not routable: the Agent is not in the repository yet' },
  };
  return {
    id: agentId,
    displayName: title,
    description: 'Proposed. This Agent appears in full once its pull request merges.',
    owner: 'unknown until merged',
    lifecycle: 'draft',
    enabled: false,
    modelProfile: '—',
    modelTier: '—',
    mcpCount: 0,
    toolCount: 0,
    workloadClientId: `sre-agent-${agentId}`,
    readOnly: true,
    reconciliation,
  };
}
