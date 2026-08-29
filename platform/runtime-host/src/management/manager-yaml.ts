import { agentDocumentSchema, assertNoSecretMaterial, type AgentDocument, type AgentLifecycle } from "@sre/agent-schema";
import { toRepoPath, type ManagerAgentConfig } from "@sre/config";
import { AgentDraftError, type GeneratedFile, type ProposedChange } from "./yaml.ts";

/**
 * Manager draft → canonical YAML, the Manager's half of TDD §29/§30.
 *
 * The Manager is a SEPARATE branch of the Agent document union, not a
 * specialist with fields left blank: it has no workload identity, no MCP
 * access, no environments and no routing vocabulary, and it has `agents.allowed`
 * and `output.schema`, which no specialist has. Generating it through
 * `draftToDocument` would therefore produce a document the schema rejects, so
 * it gets its own draft type and its own renderer.
 *
 * What it shares with the specialist path is the part that matters: the draft
 * is validated against the SAME schema the runtime loads, and the result is a
 * pull request rather than a live mutation. The runtime has no way to write it.
 */

export interface ManagerDraft {
  /** the routing table: which specialists the Manager may dispatch to */
  allowed: string[];
  modelProfile: string;
  /** the system prompt body; persisted to config/prompts/manager.md in the same change */
  prompt: string;
  owner?: string;
  displayName?: string;
  description?: string;
  lifecycle?: AgentLifecycle;
  promptFile?: string;
  execution?: { maxAgentsPerRequest?: number; timeoutMs?: number };
}

const DEFAULT_EXECUTION = { maxAgentsPerRequest: 3, timeoutMs: 1_500 } as const;

/**
 * Build the canonical Manager document and validate it exactly as the runtime
 * would. `maxRounds` is fixed at 1 and not part of the draft: a second Manager
 * loop is a runtime feature, never configuration (TDD §5.1), and the schema
 * pins it to the literal 1 — so offering it as an editable field would only
 * ever produce a rejected document.
 */
export function managerDraftToDocument(draft: ManagerDraft): AgentDocument {
  const candidate = {
    apiVersion: "sre.ai/v1alpha1",
    kind: "Agent",
    metadata: {
      name: "manager",
      owner: draft.owner ?? "sre-platform",
      ...(draft.displayName ? { displayName: draft.displayName } : {}),
      ...(draft.description ? { description: draft.description } : {}),
    },
    spec: {
      type: "manager",
      lifecycle: draft.lifecycle ?? "active",
      // the Manager routes; it never synthesises, so its tier is pinned small
      model: { tier: "small", profile: draft.modelProfile },
      prompt: { systemFile: draft.promptFile ?? "config/prompts/manager.md" },
      agents: { allowed: draft.allowed },
      execution: {
        maxAgentsPerRequest: draft.execution?.maxAgentsPerRequest ?? DEFAULT_EXECUTION.maxAgentsPerRequest,
        maxRounds: 1,
        timeoutMs: draft.execution?.timeoutMs ?? DEFAULT_EXECUTION.timeoutMs,
      },
      output: { schema: "ManagerDecision" },
    },
  };
  const result = agentDocumentSchema.safeParse(candidate);
  if (!result.success) throw new AgentDraftError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  assertNoSecretMaterial(result.data.spec);
  return result.data;
}

/**
 * Deterministic renderer, matching the field order and inline-map style of the
 * checked-in file so a generated pull request reads as a small diff.
 */
export function renderManagerYaml(document: AgentDocument): string {
  const spec = document.spec;
  if (spec.type !== "manager") throw new Error("renderManagerYaml requires the manager document");
  const lines = [
    `apiVersion: ${document.apiVersion}`,
    `kind: ${document.kind}`,
    "metadata:",
    `  name: ${document.metadata.name}`,
    `  owner: ${document.metadata.owner}`,
  ];
  if (document.metadata.description) lines.push(`  description: ${quote(document.metadata.description)}`);
  if (document.metadata.displayName) lines.push(`  displayName: ${document.metadata.displayName}`);
  lines.push("spec:", "  type: manager");
  // the schema defaults lifecycle to "active" and the checked-in file omits it,
  // so emitting it unconditionally would add a spurious line to the first edit —
  // but omitting it unconditionally would silently DROP a deprecation
  if (spec.lifecycle !== "active") lines.push(`  lifecycle: ${spec.lifecycle}`);
  lines.push(
    `  model: { tier: ${spec.model.tier}, profile: ${spec.model.profile} }`,
    `  prompt: { systemFile: ${spec.prompt.systemFile} }`,
    "  agents:",
    `    allowed: [${spec.agents.allowed.join(", ")}]`,
    `  execution: { maxAgentsPerRequest: ${spec.execution.maxAgentsPerRequest}, maxRounds: ${spec.execution.maxRounds}, timeoutMs: ${spec.execution.timeoutMs} }`,
    `  output: { schema: ${spec.output.schema} }`,
  );
  return `${lines.join("\n")}\n`;
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export interface GeneratedManagerChange {
  path: string;
  yaml: string;
  document: AgentDocument;
  files: GeneratedFile[];
}

/**
 * The Manager's change-set is TWO files, not the specialist's three: its
 * deployment overlay lives at `deploy/environments/<env>/manager.yaml` and is a
 * per-environment decision about replicas and resources, untouched by an edit
 * to who the Manager may route to.
 */
export function generateManagerChange(draft: ManagerDraft): GeneratedManagerChange {
  const document = managerDraftToDocument(draft);
  const spec = document.spec;
  if (spec.type !== "manager") throw new Error("renderManagerYaml requires the manager document");
  const body = draft.prompt.trim();
  if (!body) throw new AgentDraftError(["prompt: a system prompt is required; the Manager cannot reference a missing or empty prompt file"]);
  const yaml = renderManagerYaml(document);
  const path = "config/agents/manager.yaml";
  return {
    path,
    yaml,
    document,
    // repository-relative, as everywhere a change-set names a file
    files: [
      { path: toRepoPath(path), contents: yaml },
      { path: toRepoPath(spec.prompt.systemFile), contents: `# ${document.metadata.displayName ?? "Manager"}\n\n${body}\n` },
    ],
  };
}

/**
 * The routing table is the Manager's whole security-relevant surface: an agent
 * removed from `allowed` stops being reachable, and one added becomes reachable
 * to every user the Manager serves. So the effects say exactly which names moved
 * rather than reporting a count, and the reviewer sees the delta in the PR body.
 */
export function proposeManagerChange(options: { draft: ManagerDraft; current: ManagerAgentConfig; requestedBy: string }): { change: ProposedChange; generated: GeneratedManagerChange } {
  const generated = generateManagerChange(options.draft);
  const spec = generated.document.spec;
  if (spec.type !== "manager") throw new Error("renderManagerYaml requires the manager document");

  const before = options.current.spec.agents.allowed;
  const after = spec.agents.allowed;
  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));

  const effects = [
    ...generated.files.map((file) => `update ${file.path}`),
    ...added.map((name) => `Routing: ${name} becomes reachable through the Manager`),
    ...removed.map((name) => `Routing: ${name} stops being reachable through the Manager`),
    `Manager: dispatches at most ${spec.execution.maxAgentsPerRequest} agent(s) per request within ${spec.execution.timeoutMs}ms`,
    "Runtime: the Manager reloads its routing table on next deploy",
    "Argo CD: sync after merge",
  ];

  const body = [
    "Update the SRE Manager agent.",
    "",
    `Requested by: ${options.requestedBy}`,
    `Owner: ${generated.document.metadata.owner}`,
    "",
    "## Routing table",
    "",
    ...after.map((name) => `- \`${name}\`${added.includes(name) ? " **(added)**" : ""}`),
    ...removed.map((name) => `- ~~\`${name}\`~~ **(removed)**`),
    "",
    "## Files in this change",
    "",
    ...generated.files.map((file) => `- \`${file.path}\``),
    "",
    "## What merging this changes",
    "",
    ...effects.map((effect) => `- ${effect}`),
    "",
    "The Manager holds no workload identity and reaches no MCP server, so this",
    "change grants no tool access. It changes which specialists a request can be",
    "routed to; each specialist's own tool access is unaffected.",
    "",
    "Generated by the Agent Management Portal. No credential is included in this change.",
  ].join("\n");

  return {
    generated,
    change: { branch: "agent/update-manager", title: "Update the SRE Manager agent", body, files: generated.files, effects },
  };
}
