import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { AgentEntityProvider } from './AgentEntityProvider';
import { runtimeManagementClientRef } from '../services/RuntimeManagementClient';

/**
 * Registers Agents and their MCP dependencies in the Backstage catalog,
 * derived from the canonical Agent definitions the runtime loads.
 *
 * @public
 */
export const catalogModuleSreAgents = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'sre-agents',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        runtime: runtimeManagementClientRef,
      },
      async init({ catalog, logger, scheduler, runtime }) {
        catalog.addEntityProvider(new AgentEntityProvider(runtime, logger, scheduler));
      },
    });
  },
});
