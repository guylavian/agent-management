import type { EntityProvider, EntityProviderConnection } from '@backstage/plugin-catalog-node';
import type { Entity } from '@backstage/catalog-model';
import type { LoggerService, SchedulerService } from '@backstage/backend-plugin-api';
import type { RuntimeManagementClient } from '../services/RuntimeManagementClient';

// generated from contracts/management-api/openapi.yaml — never hand-declared
import type { AgentDetail, AgentSummary, McpAccessView } from '../api/generated-types';

/**
 * What the catalog projection actually needs. Detail fetches can fail per agent,
 * and a partly-known agent still belongs in the catalog — so this is narrowed to
 * the fields used here rather than pretending a summary is a full AgentDetail.
 */
type CatalogAgent = AgentSummary & { access: McpAccessView[]; crossDomainAllowed: string[] };

/**
 * Derives Backstage catalog entities from the canonical Agent definitions
 * (TDD §42).
 *
 * Entities come from the runtime's projection of `config/agents/*.yaml` rather
 * than a second hand-maintained catalog-info file, so the catalog cannot disagree with
 * what the runtime actually enforces. Agents are emitted as Components owned by
 * their team, each depending on the MCP Resources it is allowed to reach.
 */
export class AgentEntityProvider implements EntityProvider {
  #connection?: EntityProviderConnection;

  constructor(
    private readonly runtime: RuntimeManagementClient,
    private readonly logger: LoggerService,
    private readonly scheduler: SchedulerService,
    private readonly frequencyMinutes = 10,
  ) {}

  getProviderName(): string {
    return 'sre-agents';
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.#connection = connection;
    if (!this.runtime.configured) {
      // no runtime wired: emit nothing rather than inventing placeholder entities
      this.logger.info('SRE agent catalog provider is idle: no runtime management API configured');
      return;
    }
    await this.scheduler.scheduleTask({
      id: 'sre-agent-catalog-refresh',
      frequency: { minutes: this.frequencyMinutes },
      timeout: { minutes: 2 },
      fn: async () => {
        try {
          await this.refresh();
        } catch (error) {
          this.logger.warn(`SRE agent catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
  }

  async refresh(): Promise<void> {
    if (this.#connection === undefined) throw new Error('provider is not connected');
    const { agents } = await this.runtime.get<{ agents: AgentSummary[] }>('/management/agents');
    const details: CatalogAgent[] = await Promise.all(
      agents.map(async agent => {
        try {
          return await this.runtime.get<AgentDetail>(`/management/agents/${encodeURIComponent(agent.id)}`);
        } catch {
          // the agent exists but its detail is unavailable; record what is known
          return { ...agent, access: [], crossDomainAllowed: [] };
        }
      }),
    );

    const mcpIds = [...new Set(details.flatMap(agent => agent.access.filter(entry => entry.allowed).map(entry => entry.mcp)))];
    const entities: Entity[] = [
      ...details.map(agent => this.#agentEntity(agent)),
      ...mcpIds.map(mcp => this.#mcpEntity(mcp)),
    ];

    await this.#connection.applyMutation({
      type: 'full',
      entities: entities.map(entity => ({ entity, locationKey: `sre-agents:${this.getProviderName()}` })),
    });
  }

  #agentEntity(agent: CatalogAgent): Entity {
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name: agent.id,
        title: agent.displayName,
        description: `SRE specialist agent (${agent.modelProfile})`,
        annotations: {
          'backstage.io/managed-by-location': `url:config/agents/${agent.id}.yaml`,
          'backstage.io/managed-by-origin-location': `url:config/agents/${agent.id}.yaml`,
          'sre.ai/workload-client-id': agent.workloadClientId,
          'sre.ai/lifecycle': agent.lifecycle,
          'sre.ai/model-profile': agent.modelProfile,
        },
        tags: ['sre-agent', `model-${agent.modelProfile}`],
      },
      spec: {
        type: 'sre-agent',
        lifecycle: agent.lifecycle,
        owner: `group:default/${agent.owner}`,
        dependsOn: agent.access.filter(entry => entry.allowed).map(entry => `resource:default/mcp-${entry.mcp}`),
      },
    };
  }

  #mcpEntity(mcp: string): Entity {
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        name: `mcp-${mcp}`,
        title: `${mcp} MCP`,
        description: `MCP server reached through ToolHive (audience sre-toolhive:${mcp})`,
        annotations: { 'sre.ai/toolhive-audience': `sre-toolhive:${mcp}` },
        tags: ['mcp', 'toolhive'],
      },
      spec: { type: 'mcp-server', owner: 'group:default/sre-platform' },
    };
  }
}
