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
  router.use(express.json());

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

  return router;
}
