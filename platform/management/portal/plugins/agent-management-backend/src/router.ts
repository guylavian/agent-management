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
import type { ChangePreview } from './api/generated-types';

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
}: {
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  runtime: typeof runtimeManagementClientRef.T;
  gitops: typeof gitOpsPublisherRef.T;
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

  const requirePermission = async (request: express.Request, permission: BasicPermission): Promise<void> => {
    const credentials = await httpAuth.credentials(request, { allow: ['user'] });
    const [decision] = await permissions.authorize([{ permission }], { credentials });
    if (decision?.result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError(`Not allowed to perform ${permission.name}`);
    }
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

  proxyGet('/agents', agentReadPermission, '/management/agents');
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
    await requirePermission(request, agentCreatePrPermission);
    if (!runtime.configured) {
      response.status(501).json({ status: 'not-configured', reason: 'sreAgent.managementApi.baseUrl is not set' });
      return;
    }
    const rendered = await runtime.post<ChangePreview>('/management/agents/preview', request.body);
    if (rendered.status !== 200) {
      response.status(rendered.status).json(rendered.body);
      return;
    }
    const preview = rendered.body;
    if (!gitops.configured) {
      response.status(501).json({ status: 'not-configured', reason: (await gitops.createPullRequest({ branch: preview.branch, title: preview.title, body: preview.body, files: preview.files })).reason, branch: preview.branch, effects: preview.effects });
      return;
    }
    const outcome = await gitops.createPullRequest({ branch: preview.branch, title: preview.title, body: preview.body, files: preview.files });
    response.status(outcome.status === 'created' ? 201 : 501).json({ ...outcome, branch: preview.branch, effects: preview.effects });
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
