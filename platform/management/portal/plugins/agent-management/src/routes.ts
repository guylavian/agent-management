import { createRouteRef } from '@backstage/frontend-plugin-api';

/**
 * Each sidebar section is its own page extension, so each needs a top-level
 * RouteRef. PageBlueprint does not accept a SubRouteRef.
 */
export const rootRouteRef = createRouteRef();
export const agentsRouteRef = createRouteRef();
export const managerRouteRef = createRouteRef();
export const createAgentRouteRef = createRouteRef();
export const permissionsRouteRef = createRouteRef();
export const mcpServersRouteRef = createRouteRef();
export const runsRouteRef = createRouteRef();
export const requestsRouteRef = createRouteRef();
