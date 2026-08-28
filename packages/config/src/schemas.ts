/**
 * The canonical Agent definition lives in @sre/agent-schema so that the
 * management plane, Keycloak provisioning and Git validation can consume it
 * without depending on the runtime config loader. This module re-exports it
 * unchanged — there is exactly one Agent schema in the repository.
 */
export * from "@sre/agent-schema";
