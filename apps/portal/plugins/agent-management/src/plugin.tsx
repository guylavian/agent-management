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
    path: '/',
    title: 'Overview',
    noHeader: true,
    routeRef: rootRouteRef,
    loader: () => import('./components/OverviewPage').then(m => <m.OverviewPage />),
  },
});

export const agentsPage = PageBlueprint.make({
  name: 'agents',
  params: {
    path: '/agents',
    title: 'Agents',
    noHeader: true,
    routeRef: agentsRouteRef,
    loader: () => import('./components/AgentsRoutes').then(m => <m.AgentsRoutes />),
  },
});

export const createAgentPage = PageBlueprint.make({
  name: 'create-agent',
  params: {
    path: '/create-agent',
    title: 'Create Agent',
    noHeader: true,
    routeRef: createAgentRouteRef,
    loader: () => import('./components/CreateAgentPage').then(m => <m.CreateAgentPage />),
  },
});

export const permissionsPage = PageBlueprint.make({
  name: 'permissions',
  params: {
    path: '/permissions',
    title: 'Permissions',
    noHeader: true,
    routeRef: permissionsRouteRef,
    loader: () => import('./components/PermissionsPage').then(m => <m.PermissionsPage />),
  },
});

export const mcpServersPage = PageBlueprint.make({
  name: 'mcp-servers',
  params: {
    path: '/mcp-servers',
    title: 'MCP Servers',
    noHeader: true,
    routeRef: mcpServersRouteRef,
    loader: () => import('./components/McpServersPage').then(m => <m.McpServersPage />),
  },
});

export const runsPage = PageBlueprint.make({
  name: 'runs',
  params: {
    path: '/runs',
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
