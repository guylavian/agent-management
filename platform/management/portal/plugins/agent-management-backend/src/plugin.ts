import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { agentManagementPermissions } from './permissions';
import { runtimeManagementClientRef } from './services/RuntimeManagementClient';
import { gitOpsPublisherRef } from './services/GitOpsPublisher';

/**
 * Agent management backend plugin.
 *
 * Provides the portal's management operations and registers the management
 * permissions. It reads the runtime's read-only management API and never
 * enforces runtime tool access itself.
 *
 * It also owns the WRITE path: the runtime renders a change-set, this plugin
 * opens the pull request. The execution plane holds no Git credential, so it
 * cannot change the policy it enforces.
 *
 * @public
 */
export const agentManagementPlugin = createBackendPlugin({
  pluginId: 'agent-management',
  register(env) {
    env.registerInit({
      deps: {
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        runtime: runtimeManagementClientRef,
        gitops: gitOpsPublisherRef,
      },
      async init({ httpAuth, httpRouter, permissions, permissionsRegistry, runtime, gitops }) {
        permissionsRegistry.addPermissions(agentManagementPermissions);
        httpRouter.use(
          await createRouter({
            httpAuth,
            permissions,
            runtime,
            gitops,
          }),
        );
      },
    });
  },
});
