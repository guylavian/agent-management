import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { agentManagementPermissions } from './permissions';
import { runtimeManagementClientRef } from './services/RuntimeManagementClient';
import { gitOpsPublisherRef } from './services/GitOpsPublisher';
import { InMemoryRequestStore, PostgresRequestStore, knexSqlClient, type RequestStore } from './services/RequestStore';

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
        config: coreServices.rootConfig,
        database: coreServices.database,
        logger: coreServices.logger,
      },
      async init({ httpAuth, httpRouter, permissions, permissionsRegistry, runtime, gitops, config, database, logger }) {
        permissionsRegistry.addPermissions(agentManagementPermissions);

        /*
         * DURABLE WHEN THERE IS SOMEWHERE TO BE DURABLE.
         *
         * Requests are an audit trail: who asked for which change, and what was
         * observed about it afterwards. In memory that trail ends at the next
         * backend restart, which is precisely when someone is most likely to be
         * asking what happened.
         *
         * Falling back is deliberate rather than silent — a deployment without
         * the migrations applied still works, and says in its log that the
         * record will not survive a restart.
         */
        const environment = config.getOptionalString('sreAgent.deploymentEnvironment') ?? 'production';
        let requests: RequestStore = new InMemoryRequestStore();
        try {
          const knex = await database.getClient();
          const sql = knexSqlClient(knex as unknown as { raw(sql: string, bindings?: readonly unknown[]): Promise<unknown> });
          // BOTH tables: the request row without its event log is half a trail,
          // and the failure would only surface on the first append
          await sql.query('SELECT 1 FROM sre_management_request LIMIT 1');
          await sql.query('SELECT 1 FROM sre_execution_event LIMIT 1');
          requests = new PostgresRequestStore(sql, environment);
          logger.info(`management requests are durable in ${environment}`);
        } catch (error) {
          logger.warn(
            'management requests are IN MEMORY and will not survive a restart; apply deploy/runtime/postgres/003 and 004 to make them durable',
            error instanceof Error ? error : new Error(String(error)),
          );
        }

        httpRouter.use(
          await createRouter({
            httpAuth,
            permissions,
            runtime,
            gitops,
            requests,
          }),
        );
      },
    });
  },
});
