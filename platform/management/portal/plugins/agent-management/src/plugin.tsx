import { createFrontendPlugin, PageBlueprint } from '@backstage/frontend-plugin-api';

import {
  agentsRouteRef,
  createAgentRouteRef,
  managerRouteRef,
  mcpServersRouteRef,
  permissionsRouteRef,
  requestsRouteRef,
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

/**
 * The Manager gets its own page, not a row in the Agents table: it is a
 * different document type with no identity, access or routing vocabulary, and
 * the Agents table's columns would all be blank for it.
 */
export const managerPage = PageBlueprint.make({
  name: 'manager',
  params: {
    path: '/manager',
    title: 'Manager',
    noHeader: true,
    routeRef: managerRouteRef,
    loader: () => import('./components/ManagerPage').then(m => <m.ManagerPage />),
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

/**
 * Requests sit beside Runs on purpose: a Run explains how an answer was
 * produced, a Request explains how a platform change was applied, and both are
 * the same execution-trace model with different domain events.
 */
export const requestsPage = PageBlueprint.make({
  name: 'requests',
  params: {
    path: '/requests',
    title: 'Requests',
    noHeader: true,
    routeRef: requestsRouteRef,
    loader: () => import('./components/RequestsRoutes').then(m => <m.RequestsRoutes />),
  },
});

export const agentManagementPlugin = createFrontendPlugin({
  pluginId: 'agent-management',
  extensions: [overviewPage, agentsPage, managerPage, createAgentPage, permissionsPage, mcpServersPage, runsPage, requestsPage],
  routes: {
    root: rootRouteRef,
    agents: agentsRouteRef,
    create: createAgentRouteRef,
    permissions: permissionsRouteRef,
    mcpServers: mcpServersRouteRef,
    runs: runsRouteRef,
    requests: requestsRouteRef,
  },
});
