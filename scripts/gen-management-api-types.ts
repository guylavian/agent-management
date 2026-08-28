import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * Generates TypeScript types for BOTH sides of the management API from the one
 * OpenAPI document that defines it.
 *
 * The runtime (npm workspace) and the portal (Backstage Yarn workspace) cannot
 * share TypeScript source without coupling their toolchains, so before this they
 * each hand-declared the same twenty shapes and drifted quietly. Now the shapes
 * have one source and two generated copies, each checked into the workspace
 * that consumes it, and `npm run check:generated` fails on any drift.
 *
 * Deliberately a small emitter for the subset this contract uses rather than a
 * general OpenAPI generator: a new dependency to translate our own document
 * would be more code to trust than the eighty lines below.
 */

interface Schema {
  type?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: Schema | boolean;
  description?: string;
  $ref?: string;
  oneOf?: Schema[];
}

const document = parseYaml(readFileSync("contracts/management-api/openapi.yaml", "utf8")) as {
  info: { version: string };
  components: { schemas: Record<string, Schema> };
};

function refName(ref: string): string {
  return ref.replace("#/components/schemas/", "");
}

function typeOf(schema: Schema, indent: string): string {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.oneOf) return schema.oneOf.map((item) => typeOf(item, indent)).join(" | ");
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `Array<${typeOf(schema.items ?? {}, indent)}>`;
    case "object": {
      if (schema.properties) return objectBody(schema, indent);
      const value = typeof schema.additionalProperties === "object" ? typeOf(schema.additionalProperties, indent) : "unknown";
      return `Record<string, ${value}>`;
    }
    default:
      return "unknown";
  }
}

function objectBody(schema: Schema, indent: string): string {
  const required = new Set(schema.required ?? []);
  const inner = `${indent}  `;
  const lines: string[] = ["{"];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (property.description) lines.push(`${inner}/** ${property.description.trim().replaceAll("\n", " ")} */`);
    lines.push(`${inner}${name}${required.has(name) ? "" : "?"}: ${typeOf(property, inner)};`);
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

function emit(banner: string): string {
  const parts: string[] = [banner];
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    if (schema.description) parts.push(`/**\n * ${schema.description.trim().replaceAll("\n", "\n * ")}\n */`);
    if (schema.type === "object" && schema.properties) {
      parts.push(`export interface ${name} ${objectBody(schema, "")}`);
    } else {
      parts.push(`export type ${name} = ${typeOf(schema, "")};`);
    }
  }
  parts.push(`/** Endpoints answer this shape when the deployment has no backend wired. */
export function isNotConfigured(value: unknown): value is NotConfigured {
  return typeof value === "object" && value !== null && (value as NotConfigured).status === "not-configured";
}`);
  return `${parts.join("\n\n")}\n`;
}

const BANNER = `/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by \`npm run gen:management-api\` from contracts/management-api/openapi.yaml
 * (version ${document.info.version}). CI re-generates and fails on any diff, so an
 * edit here is lost rather than applied — change the OpenAPI document instead.
 */`;

// One copy per consuming workspace. The portal's two plugins are separate Yarn
// packages that cannot import each other's src, so each gets the generated file.
const outputs = [
  "contracts/management-api/generated/types.ts",
  "portal/plugins/agent-management/src/api/generated-types.ts",
  "portal/plugins/agent-management-backend/src/api/generated-types.ts",
];

for (const path of outputs) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, emit(BANNER), "utf8");
  console.log(`generated ${path}`);
}
