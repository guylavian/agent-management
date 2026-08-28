import { createRouteRef, createSubRouteRef } from '@backstage/frontend-plugin-api';

export const rootRouteRef = createRouteRef();

export const agentsRouteRef = createSubRouteRef({ parent: rootRouteRef, path: '/agents' });
export const createAgentRouteRef = createSubRouteRef({ parent: rootRouteRef, path: '/create' });
export const permissionsRouteRef = createSubRouteRef({ parent: rootRouteRef, path: '/permissions' });
export const mcpServersRouteRef = createSubRouteRef({ parent: rootRouteRef, path: '/mcp-servers' });
export const runsRouteRef = createSubRouteRef({ parent: rootRouteRef, path: '/runs' });
