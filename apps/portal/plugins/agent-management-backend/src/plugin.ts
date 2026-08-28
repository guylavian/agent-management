import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { agentManagementPermissions } from './permissions';
import { runtimeManagementClientRef } from './services/RuntimeManagementClient';

/**
 * Agent management backend plugin.
 *
 * Provides the portal's management operations and registers the management
 * permissions. It proxies to the SRE runtime's read-only management API and
 * never enforces runtime tool access itself.
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
      },
      async init({ httpAuth, httpRouter, permissions, permissionsRegistry, runtime }) {
        permissionsRegistry.addPermissions(agentManagementPermissions);
        httpRouter.use(
          await createRouter({
            httpAuth,
            permissions,
            runtime,
          }),
        );
      },
    });
  },
});
