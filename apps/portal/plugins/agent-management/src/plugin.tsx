import { createFrontendPlugin, PageBlueprint } from '@backstage/frontend-plugin-api';

import {
  agentsRouteRef,
  createAgentRouteRef,
  mcpServersRouteRef,
  permissionsRouteRef,
  rootRouteRef,
  runsRouteRef,
} from './routes';

/**
 * Agent Management portal.
 *
 * One page extension per sidebar section — Backstage derives the nav entry from
 * each page, so the product's own navigation is what the user sees rather than
 * a single "plugin" entry. `noHeader` keeps Backstage's default page chrome out
 * of the way so the product surface reads as its own application.
 */

export const overviewPage = PageBlueprint.make({
  name: 'overview',
  params: {
    path: '/agent-management',
    title: 'Overview',
    noHeader: true,
    routeRef: rootRouteRef,
    loader: () => import('./components/OverviewPage').then(m => <m.OverviewPage />),
  },
});

export const agentsPage = PageBlueprint.make({
  name: 'agents',
  params: {
    path: '/agent-management/agents',
    title: 'Agents',
    noHeader: true,
    routeRef: agentsRouteRef,
    loader: () => import('./components/AgentsRoutes').then(m => <m.AgentsRoutes />),
  },
});

export const createAgentPage = PageBlueprint.make({
  name: 'create-agent',
  params: {
    path: '/agent-management/create',
    title: 'Create Agent',
    noHeader: true,
    routeRef: createAgentRouteRef,
    loader: () => import('./components/CreateAgentPage').then(m => <m.CreateAgentPage />),
  },
});

export const permissionsPage = PageBlueprint.make({
  name: 'permissions',
  params: {
    path: '/agent-management/permissions',
    title: 'Permissions',
    noHeader: true,
    routeRef: permissionsRouteRef,
    loader: () => import('./components/PermissionsPage').then(m => <m.PermissionsPage />),
  },
});

export const mcpServersPage = PageBlueprint.make({
  name: 'mcp-servers',
  params: {
    path: '/agent-management/mcp-servers',
    title: 'MCP Servers',
    noHeader: true,
    routeRef: mcpServersRouteRef,
    loader: () => import('./components/McpServersPage').then(m => <m.McpServersPage />),
  },
});

export const runsPage = PageBlueprint.make({
  name: 'runs',
  params: {
    path: '/agent-management/runs',
    title: 'Runs',
    noHeader: true,
    routeRef: runsRouteRef,
    loader: () => import('./components/RunsRoutes').then(m => <m.RunsRoutes />),
  },
});

export const agentManagementPlugin = createFrontendPlugin({
  pluginId: 'agent-management',
  extensions: [overviewPage, agentsPage, createAgentPage, permissionsPage, mcpServersPage, runsPage],
  routes: {
    root: rootRouteRef,
    agents: agentsRouteRef,
    create: createAgentRouteRef,
    permissions: permissionsRouteRef,
    mcpServers: mcpServersRouteRef,
    runs: runsRouteRef,
  },
});
