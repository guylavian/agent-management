import { parse as parseYaml, parseDocument, isMap, isSeq } from "yaml";
import { agentDocumentSchema, assertNoSecretMaterial, toolHiveAudience, workloadClientId, type AgentDocument, type AgentLifecycle } from "@sre/agent-schema";
import { agentDeploymentOverlaySchema, configBaseDir, deployEnvironmentDir, deploymentEnvironments, loadModelBindings, renderAgentValues, renderedValuesToYaml, renderManagerValues, toRepoPath, type SpecialistAgentConfig } from "@sre/config";
import { avatarAssetPath, isManagedAvatarPath, validateAvatar, AvatarError, type AvatarFit } from "./avatar.ts";

/**
 * Agent draft → canonical YAML for the GitOps change (TDD §29/§30).
 *
 * The draft is validated against the SAME schema the runtime loads, so the
 * portal cannot generate a file that would fail at startup, and the generated
 * text is the entire change: creating an Agent produces a pull request, never a
 * live mutation.
 */

export interface AgentDraft {
  name: string;
  owner: string;
  displayName?: string;
  lifecycle?: AgentLifecycle;
  modelTier: "small" | "large";
  modelProfile: string;
  promptFile?: string;
  /** the system prompt body; persisted to config/prompts/<name>.md in the same change */
  prompt?: string;
  description?: string;
  /** logical environments the Agent is defined for; deployment is a separate, per-environment decision */
  environments?: string[];
  routing?: { capabilities?: string[]; exclusions?: string[] };
  requiredRoles: string[];
  crossDomainAllowed?: string[];
  access: Array<{ mcp: string; tools: string[] }>;
  /**
   * Presentation only, and three-valued on purpose:
   *   omitted  — leave whatever the Agent already has
   *   null     — remove it, falling back to initials
   *   object   — set it, either to an existing repo asset or to a new upload
   */
  avatar?: AgentDraftAvatar | null;
  limits?: Partial<Record<"maxToolCalls" | "maxModelTurns" | "timeoutMs" | "maxEvidenceBytes" | "maxContextTokens" | "maxEvidenceItems" | "maxRawExcerptBytes", number>>;
}

/** Either a path to an asset already in the repository, or bytes to add to it. */
export interface AgentDraftAvatar {
  /** an asset that already exists — a built-in icon, or the agent's current one */
  asset?: string;
  /** base64 bytes of a NEW upload; the change-set writes the file */
  upload?: string;
  fit?: AvatarFit;
}

const DEFAULT_LIMITS = {
  maxToolCalls: 6,
  maxModelTurns: 6,
  timeoutMs: 120_000,
  maxEvidenceBytes: 262_144,
  maxContextTokens: 12_000,
  maxEvidenceItems: 32,
  maxRawExcerptBytes: 8_192,
} as const;

/** Every environment the platform knows about; a draft may narrow it. */
const DEFAULT_ENVIRONMENTS = ["prod", "dr", "lab"] as const;

export interface GeneratedFile {
  path: string;
  contents: string;
  /** the file is removed by this change; `contents` is empty */
  deleted?: boolean;
  /**
   * `base64` when `contents` carries bytes rather than text.
   *
   * The publisher base64-encodes UTF-8 text on the way to the Git API, which
   * silently mangles anything that is not text. An avatar is the first binary
   * file this platform commits, so the encoding travels with the file instead
   * of being inferred from its extension.
   */
  encoding?: "base64";
}

export interface GeneratedChange {
  /** repo-relative path the Agent document belongs at */
  path: string;
  yaml: string;
  document: AgentDocument;
  /**
   * The COMPLETE change-set. An Agent that references a prompt file which the
   * same change does not create would fail startup the moment it is deployed,
   * and an Agent with no deployment overlay would never be rendered — so all
   * three files are produced together or the change is not proposable.
   */
  files: GeneratedFile[];
}

export class AgentDraftError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid agent draft: ${issues.join("; ")}`);
    this.name = "AgentDraftError";
    this.issues = issues;
  }
}

/** Build the canonical document for a draft and validate it exactly as the runtime would. */
export function draftToDocument(draft: AgentDraft): AgentDocument {
  const candidate = {
    apiVersion: "sre.ai/v1alpha1",
    kind: "Agent",
    metadata: {
      name: draft.name,
      owner: draft.owner,
      ...(draft.displayName ? { displayName: draft.displayName } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      ...(avatarMetadata(draft) === undefined ? {} : { avatar: avatarMetadata(draft) }),
    },
    spec: {
      type: "specialist",
      lifecycle: draft.lifecycle ?? "draft",
      model: { tier: draft.modelTier, profile: draft.modelProfile },
      prompt: { systemFile: draft.promptFile ?? `config/prompts/${draft.name}.md` },
      // the workload client id is derived, never author-supplied
      identity: { provider: "keycloak", clientId: workloadClientId(draft.name) },
      environments: draft.environments ?? [...DEFAULT_ENVIRONMENTS],
      routing: {
        capabilities: draft.routing?.capabilities ?? [],
        exclusions: draft.routing?.exclusions ?? [],
      },
      access: draft.access.map((entry) => ({ mcp: entry.mcp, audience: toolHiveAudience(entry.mcp), tools: entry.tools })),
      execution: { ...DEFAULT_LIMITS, ...draft.limits },
      ...(draft.crossDomainAllowed?.length ? { discovery: { allowedNeedsDomains: draft.crossDomainAllowed } } : {}),
      authorization: { requiredRoles: draft.requiredRoles },
      security: { readOnly: true },
    },
  };
  const result = agentDocumentSchema.safeParse(candidate);
  if (!result.success) throw new AgentDraftError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  assertNoSecretMaterial(result.data.spec);
  // metadata was outside the scan, which was survivable while it held only a
  // name and a sentence; it now takes a caller-supplied path, so it is scanned
  assertNoSecretMaterial(result.data.metadata);
  return result.data;
}

/**
 * The `metadata.avatar` block, or nothing.
 *
 * `null` means remove, which is why this returns undefined for it — the field
 * is then simply absent from the regenerated document and the console falls
 * back to initials. An upload resolves to the path the bytes will be written
 * to, so the document and the asset can never disagree about the filename.
 */
function avatarMetadata(draft: AgentDraft): { asset: string; fit: AvatarFit } | undefined {
  if (draft.avatar === undefined || draft.avatar === null) return undefined;
  const fit: AvatarFit = draft.avatar.fit ?? "contain";

  if (draft.avatar.upload !== undefined) {
    const asset = validateAvatar(decodeUpload(draft.avatar.upload));
    return { asset: avatarAssetPath(draft.name, asset.format), fit };
  }
  if (draft.avatar.asset !== undefined) {
    // a path the caller supplied: it must be one this platform manages, so a
    // draft cannot point the console at an arbitrary file in the repository
    if (!isManagedAvatarPath(draft.avatar.asset) && !/^assets\/icons\/[a-z][a-z0-9-]*\.(png|jpg|webp)$/u.test(draft.avatar.asset)) {
      throw new AgentDraftError(["avatar: must reference an asset under assets/agents or assets/icons"]);
    }
    return { asset: draft.avatar.asset, fit };
  }
  return undefined;
}

/** Strict base64. A data: URL or whitespace-padded blob is a malformed upload. */
function decodeUpload(upload: string): Buffer {
  const cleaned = upload.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(cleaned)) throw new AvatarError("the upload is not base64-encoded image data");
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length === 0) throw new AvatarError("the upload is empty");
  return bytes;
}

/** Environments an Agent is enabled in on creation. Deployment is opt-in per environment. */
export const DEFAULT_TARGET_ENVIRONMENT = "production";

/**
 * The Manager's rendered values, for every environment that deploys one.
 *
 * Rendering uses the SAME code as the renderer script (@sre/config), so the two
 * cannot disagree about which Agents belong in the bundle — the drift
 * `check:generated` exists to catch.
 */
function managerBundleFiles(pending: Parameters<typeof renderManagerValues>[1]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const environment of deploymentEnvironments()) {
    const values = renderManagerValues(environment, pending);
    if (values === undefined) continue;
    files.push({ path: `deploy/environments/${environment}/rendered/agents/manager.yaml`, contents: renderedValuesToYaml(values) });
  }
  return files;
}

export function generateAgentChange(draft: AgentDraft, targetEnvironment: string = DEFAULT_TARGET_ENVIRONMENT): GeneratedChange {
  const document = draftToDocument(draft);
  const name = document.metadata.name;
  const spec = document.spec;
  if (spec.type !== "specialist") throw new Error("only specialist agents are generated by the portal");
  const yaml = renderAgentYaml(document);
  const path = `config/agents/${name}.yaml`;
  const deployed = spec.lifecycle === "active";
  const overlayYaml = renderDeploymentOverlay(name, deployed);
  const renderedYaml = renderedValuesToYaml(renderAgentValues(
    document,
    agentDeploymentOverlaySchema.parse(parseYaml(overlayYaml)),
    // resolved from the configured base, not the CWD: behind git-sync the
    // working directory is a worktree that has already been deleted
    loadModelBindings(deployEnvironmentDir(targetEnvironment), configBaseDir()),
    targetEnvironment,
    renderPrompt(draft, document),
    // the SAME bytes this change-set commits to config/agents, so the mounted
    // copy and the file in Git cannot differ for an Agent created here
    yaml,
  ));
  const uploadFile: GeneratedFile | undefined =
    draft.avatar?.upload === undefined || document.metadata.avatar === undefined
      ? undefined
      : { path: toRepoPath(document.metadata.avatar.asset), contents: Buffer.from(decodeUpload(draft.avatar.upload)).toString("base64"), encoding: "base64" };
  return {
    path,
    yaml,
    document,
    // REPOSITORY-relative: a change-set is committed to Git, where the runtime's
    // own `config/` is `platform/config/`. The document's internal references
    // stay runtime-relative, because that is what the runtime resolves.
    files: [
      { path: toRepoPath(path), contents: yaml },
      { path: toRepoPath(spec.prompt.systemFile), contents: renderPrompt(draft, document) },
      { path: `deploy/environments/${targetEnvironment}/agents/${name}.yaml`, contents: overlayYaml },
      /*
       * The rendered Helm values — but ONLY for an Agent that is actually
       * deployed.
       *
       * Argo's ApplicationSet globs `rendered/`, so an Agent whose render is
       * missing is one Argo never sees. That makes this file mandatory for an
       * active Agent and FORBIDDEN for a draft: `tools/render-agent-deployment`
       * skips every disabled overlay, so writing one here for a draft put a
       * file in the change-set that the canonical renderer immediately deletes.
       *
       * Two implementations of "which Agents get rendered", disagreeing. The
       * visible symptom was a merged pull request that left `main` failing its
       * own `check:generated` gate, and the invisible one was worse: had the
       * file survived, Argo would have deployed an Agent whose own document
       * says it is a draft.
       *
       * Rendering itself uses the SAME function the renderer script does, so
       * the CONTENT cannot drift either.
       */
      ...(deployed ? [{ path: `deploy/environments/${targetEnvironment}/rendered/agents/${name}.yaml`, contents: renderedYaml }] : []),
      /*
       * THE MANAGER'S OWN BUNDLE MOVES TOO — for every environment, not just
       * this one.
       *
       * That bundle carries the CANONICAL registry: every Agent that exists,
       * deployed here or not. Adding an Agent therefore changes it everywhere,
       * and a change-set that left it alone merged cleanly and then failed the
       * repository's own `check:generated` gate — while a production Manager,
       * which reads these mounts rather than a git checkout, never learned the
       * Agent existed at all. Observed on a real merge: the console listed the
       * new Agent only because this cluster happens to run git-sync.
       */
      ...managerBundleFiles({ added: new Map([[name, { document, yaml, prompt: renderPrompt(draft, document) }]]), overlays: { [`${name}.yaml`]: overlayYaml } }),
      // an uploaded avatar rides in the SAME change-set as the document that
      // references it, so a merged pull request can never leave the console
      // pointing at a file that is not there
      ...(uploadFile === undefined ? [] : [uploadFile]),
    ],
  };
}

/**
 * The prompt the operator typed, persisted verbatim under a heading. An Agent
 * whose prompt file is missing or empty fails config load, so a draft without
 * a prompt is rejected rather than generating a file the runtime will refuse.
 */
function renderPrompt(draft: AgentDraft, document: AgentDocument): string {
  const body = draft.prompt?.trim();
  if (!body) throw new AgentDraftError(["prompt: a system prompt is required; an Agent cannot reference a missing or empty prompt file"]);
  const title = document.metadata.displayName ?? document.metadata.name;
  return `# ${title}\n\n${body}\n`;
}

/**
 * Deployment overlay only. Everything logical about the Agent is in the
 * canonical document; the overlay schema rejects those fields outright.
 */
function renderDeploymentOverlay(name: string, enabled: boolean): string {
  return [
    "apiVersion: sre.ai/v1alpha1",
    "kind: AgentDeployment",
    "# Deployment overlay ONLY. Routing, capabilities, prompt, tool access and",
    `# ownership are properties of the Agent and live in config/agents/${name}.yaml;`,
    "# the schema rejects them here.",
    `agentId: ${name}`,
    `enabled: ${enabled}`,
    "replicas: 2",
    "resources:",
    "  requests: { cpu: 500m, memory: 512Mi }",
    '  limits: { cpu: "1", memory: 1Gi }',
    "",
  ].join("\n");
}

/**
 * Deterministic renderer. Hand-written rather than a YAML library so the output
 * matches the field order and inline-map style of the checked-in files, keeping
 * generated pull requests reviewable as small diffs.
 */
export function renderAgentYaml(document: AgentDocument): string {
  const spec = document.spec;
  if (spec.type !== "specialist") throw new Error("only specialist agents are generated by the portal");
  const lines: string[] = [
    `apiVersion: ${document.apiVersion}`,
    `kind: ${document.kind}`,
    "metadata:",
    `  name: ${document.metadata.name}`,
    `  owner: ${document.metadata.owner}`,
  ];
  if (document.metadata.description) lines.push(`  description: ${quote(document.metadata.description)}`);
  if (document.metadata.displayName) lines.push(`  displayName: ${document.metadata.displayName}`);
  if (document.metadata.avatar) {
    lines.push("  avatar:", `    asset: ${document.metadata.avatar.asset}`, `    fit: ${document.metadata.avatar.fit}`);
  }
  lines.push(
    "spec:",
    "  type: specialist",
    `  lifecycle: ${spec.lifecycle}`,
    `  model: { tier: ${spec.model.tier}, profile: ${spec.model.profile} }`,
    `  prompt: { systemFile: ${spec.prompt.systemFile} }`,
    `  identity: { provider: ${spec.identity.provider}, clientId: ${spec.identity.clientId} }`,
    `  environments: [${spec.environments.map(quote).join(", ")}]`,
    "  routing:",
    `    capabilities: [${spec.routing.capabilities.map(quote).join(", ")}]`,
    `    exclusions: [${spec.routing.exclusions.map(quote).join(", ")}]`,
    "  access:",
  );
  for (const entry of spec.access) {
    lines.push(`    - mcp: ${entry.mcp}`);
    lines.push(`      audience: ${entry.audience ?? toolHiveAudience(entry.mcp)}`);
    lines.push(`      tools: [${entry.tools.join(", ")}]`);
  }
  const execution = Object.entries(spec.execution).map(([key, value]) => `${key}: ${value}`).join(", ");
  lines.push(`  execution: { ${execution} }`);
  if (spec.discovery?.allowedNeedsDomains.length) {
    lines.push(`  discovery: { allowedNeedsDomains: [${spec.discovery.allowedNeedsDomains.join(", ")}] }`);
  }
  lines.push(`  authorization: { requiredRoles: [${spec.authorization.requiredRoles.join(", ")}] }`);
  lines.push("  security: { readOnly: true }");
  return `${lines.join("\n")}\n`;
}

/** YAML double-quoting for free text; routing terms and descriptions contain colons and commas. */
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The complete proposal for a change-set: what to call the branch, what the
 * pull request should say, and what merging it will cause.
 *
 * Rendered by the execution plane because it owns the canonical schema and the
 * effects; PUBLISHED by the management plane, which owns the Git credential.
 * The runtime deliberately has no way to write it.
 */
export interface ProposedChange {
  branch: string;
  title: string;
  body: string;
  files: GeneratedFile[];
  effects: string[];
}

export interface ProposeOptions {
  draft: AgentDraft;
  /** username or subject of the requester, recorded in the PR body for audit */
  requestedBy: string;
  /** true when the agent already exists, so the summary says "update" */
  update?: boolean;
  /** which environment the new Agent is enabled in; deployment is opt-in per environment */
  targetEnvironment?: string;
  /**
   * Every specialist that exists, for validating cross-domain grants.
   *
   * `allowedNeedsDomains` naming an agent that does not exist is refused by
   * StaticAgentCatalog — at STARTUP, in every environment. A draft carrying one
   * therefore proposes cleanly, merges, and then stops the platform from
   * loading its configuration at all. Catching it here turns a fleet-wide
   * outage into a form error.
   *
   * Optional so a caller without a registry still gets everything else.
   */
  knownAgents?: string[];
}

/**
 * The fields `generateAgentChange` dereferences without checking.
 *
 * Without this an incomplete draft reached `.map()` on an undefined field and
 * threw a raw TypeError, which the preview route then reported as
 * GITOPS_UNAVAILABLE — sending an operator to check GitHub for what was a form
 * with an empty box. Naming every missing field at once matters too: failing on
 * the first undefined makes fixing a draft an N-round trip.
 */
function assertDraftIsComplete(draft: AgentDraft): void {
  const issues: string[] = [];
  const required: Array<[keyof AgentDraft, string]> = [
    ["name", "name is required"],
    ["owner", "owner is required"],
    ["modelTier", "modelTier is required"],
    ["modelProfile", "modelProfile is required"],
  ];
  for (const [field, message] of required) {
    const value = draft?.[field];
    if (typeof value !== "string" || value.trim() === "") issues.push(message);
  }
  if (!Array.isArray(draft?.requiredRoles)) issues.push("requiredRoles is required, and must be a list");
  if (!Array.isArray(draft?.access)) issues.push("access is required, and must be a list of { mcp, tools }");
  else {
    for (const [index, entry] of draft.access.entries()) {
      if (typeof entry?.mcp !== "string" || entry.mcp.trim() === "") issues.push(`access[${index}].mcp is required`);
      if (!Array.isArray(entry?.tools)) issues.push(`access[${index}].tools is required, and must be a list`);
    }
  }
  if (issues.length > 0) throw new AgentDraftError(issues);
}

export function proposeAgentChange(options: ProposeOptions): { change: ProposedChange; generated: GeneratedChange } {
  assertDraftIsComplete(options.draft);
  const generated = generateAgentChange(options.draft, options.targetEnvironment);
  const name = generated.document.metadata.name;
  const spec = generated.document.spec;
  if (spec.type !== "specialist") throw new Error("only specialist agents are proposed by the portal");

  if (options.knownAgents !== undefined) {
    // A self-edge is already refused by the document schema ("agent cannot
    // discover itself"), so the only gap is a target that does not exist.
    const known = new Set(options.knownAgents);
    const dangling = (spec.discovery?.allowedNeedsDomains ?? []).filter((target) => target !== name && !known.has(target));
    if (dangling.length > 0) {
      throw new AgentDraftError(dangling.map((target) => `crossDomainAllowed: "${target}" is not an agent that exists`));
    }
  }

  const verb = options.update === true ? "Update" : "Add";
  const environment = options.targetEnvironment ?? DEFAULT_TARGET_ENVIRONMENT;

  const effects = [
    ...generated.files.map((file) => `${options.update === true ? "update" : "create"} ${file.path}`),
    `Keycloak: reconcile workload client ${spec.identity.clientId} (${spec.lifecycle === "active" ? "enabled" : "disabled"})`,
    ...spec.access.map((entry) => `Keycloak: optional scope sre-toolhive-${entry.mcp} and ${entry.tools.length} tool grant(s) on ${entry.mcp}`),
    `ToolHive: gateway policy grants ${spec.identity.clientId} ${spec.access.reduce((total, entry) => total + entry.tools.length, 0)} tool(s)`,
    `Runtime: allowlist ${spec.access.length} MCP(s), ${spec.access.reduce((total, entry) => total + entry.tools.length, 0)} tool(s)`,
    /*
     * WHETHER ANYTHING DEPLOYS, said out loud.
     *
     * This used to read "Argo CD: sync after merge" unconditionally, which is
     * false for a draft: the overlay is written with `enabled: false`, the
     * renderer emits no Application for it, and Argo does nothing. A reviewer
     * approved a change whose stated effect was a deployment and got silence,
     * with nothing anywhere to explain the difference.
     */
    spec.lifecycle === "active"
      ? `Argo CD: deploys ${name} to ${environment} after merge`
      : `Argo CD: NOTHING is deployed — lifecycle is "${spec.lifecycle}", so the ${environment} overlay is written with enabled: false. Set the lifecycle to active to deploy.`,
  ];

  const body = [
    `${verb} the \`${name}\` SRE specialist agent.`,
    "",
    `Requested by: ${options.requestedBy}`,
    `Owner: ${generated.document.metadata.owner}`,
    `Lifecycle: ${spec.lifecycle}`,
    `Workload identity: \`${spec.identity.clientId}\``,
    "",
    "## Effective access",
    "",
    ...spec.access.map((entry) => `- \`${entry.mcp}\` (aud \`${entry.audience}\`): ${entry.tools.join(", ")}`),
    "",
    "## Files in this change",
    "",
    ...generated.files.map((file) => `- \`${file.path}\``),
    "",
    "## What merging this changes",
    "",
    ...effects.map((effect) => `- ${effect}`),
    "",
    "Generated by the Agent Management Portal. No credential is included in this change.",
  ].join("\n");

  return {
    generated,
    change: {
      branch: `agent/${options.update === true ? "update" : "add"}-${name}`,
      title: `${verb} ${name} SRE agent`,
      body,
      files: generated.files,
      effects,
    },
  };
}

/**
 * A change-set that touches ONLY the prompt file.
 *
 * The prompt is its own file, so editing it needs no round-trip through
 * AgentDraft — which matters: AgentDetailView carries no routing or
 * capabilities, so rebuilding a draft from it and re-rendering the Agent
 * document would silently drop them. One file in, one file out; the Agent
 * document is not touched and therefore cannot be damaged.
 */
export function proposePromptChange(options: { agent: SpecialistAgentConfig; prompt: string; requestedBy: string }): ProposedChange {
  const body = options.prompt.trim();
  if (!body) throw new AgentDraftError(["prompt: a system prompt is required; an Agent cannot reference a missing or empty prompt file"]);
  const name = options.agent.name;
  const path = options.agent.spec.prompt.systemFile;
  const title = options.agent.displayName ?? name;
  return {
    branch: `agent/${name}-prompt`,
    title: `Update the ${name} agent system prompt`,
    files: [{ path: toRepoPath(path), contents: `# ${title}\n\n${body}\n` }],
    effects: [`update ${toRepoPath(path)}`, "Runtime: specialist reloads the prompt on next deploy", "Argo CD: sync after merge"],
    body: [
      `Update the system prompt for the \`${name}\` SRE specialist agent.`,
      "",
      `Requested by: ${options.requestedBy}`,
      `Owner: ${options.agent.owner}`,
      "",
      "Only the prompt file changes. The Agent document, its tool access, its",
      "identity and its deployment overlay are untouched by this change.",
      "",
      "## Files in this change",
      "",
      `- \`${path}\``,
      "",
    ].join("\n"),
  };
}

/**
 * DELETE AN AGENT — every file it owns, and every mention of it, in ONE pull request.
 *
 * The set is what is actually in the repository, not what the schema says
 * should be: the caller passes an `exists` probe and only files that exist are
 * proposed, so a change-set never tries to delete a rendered file for an Agent
 * that was never deployed, or an avatar it never had. Deployment overlays and
 * rendered values are removed for EVERY environment — a half-deleted Agent that
 * still deploys in `dr` is worse than either state.
 *
 * Other Agents that grant this one cross-domain access are REWRITTEN in the
 * same change: the catalog refuses a dangling `allowedNeedsDomains` target at
 * startup in every environment, so leaving the grant would make the merge stop
 * the platform loading its configuration. The document is edited in place with
 * the YAML AST so its layout and comments survive; only the one entry goes.
 */
export function proposeAgentDeletion(options: {
  agent: SpecialistAgentConfig;
  requestedBy: string;
  environments: readonly string[];
  /** every OTHER specialist, so grants pointing at this Agent can be removed */
  others: readonly SpecialistAgentConfig[];
  exists: (repoPath: string) => boolean;
  /** the current document text of another Agent, for the rewrite */
  read: (repoPath: string) => string;
}): ProposedChange {
  const name = options.agent.name;
  const dependants = options.others.filter((other) => other.spec.discovery?.allowedNeedsDomains?.includes(name));
  const rewritten: GeneratedFile[] = dependants.map((other) => {
    const path = toRepoPath(`config/agents/${other.name}.yaml`);
    return { path, contents: removeGrant(options.read(path), name) };
  });
  const candidates = [
    toRepoPath(`config/agents/${name}.yaml`),
    toRepoPath(options.agent.spec.prompt.systemFile),
    ...(options.agent.avatar && isManagedAvatarPath(options.agent.avatar.asset) ? [toRepoPath(options.agent.avatar.asset)] : []),
    ...options.environments.flatMap((environment) => [
      `deploy/environments/${environment}/agents/${name}.yaml`,
      `deploy/environments/${environment}/rendered/agents/${name}.yaml`,
    ]),
  ];
  const removed: GeneratedFile[] = [...new Set(candidates)].filter(options.exists).map((path) => ({ path, contents: "", deleted: true }));
  if (removed.length === 0) throw new AgentDraftError([`${name}: no files found to remove`]);
  const files = [...removed, ...rewritten];
  return {
    branch: `agent/remove-${name}`,
    title: `Remove the ${name} agent`,
    files,
    effects: [
      ...removed.map((file) => `delete ${file.path}`),
      ...dependants.map((other) => `update ${toRepoPath(`config/agents/${other.name}.yaml`)}: ${other.name} no longer grants cross-domain access to ${name}`),
      `Argo CD: the ${name} Application is pruned from every environment after merge`,
      `Manager: ${name} leaves the routing catalog once the runtime reloads`,
      `Keycloak: the ${options.agent.spec.identity.clientId} workload client should be retired separately`,
    ],
    body: [
      `Remove the \`${name}\` SRE specialist agent and everything it owns.`,
      "",
      `Requested by: ${options.requestedBy}`,
      "",
      "## Files removed",
      ...removed.map((file) => `- \`${file.path}\``),
      ...(dependants.length === 0 ? [] : ["", "## Cross-domain grants removed", ...dependants.map((other) => `- \`${other.name}\` no longer lists \`${name}\` in \`allowedNeedsDomains\``)]),
    ].join("\n"),
  };
}

/**
 * Drop one target from `spec.discovery.allowedNeedsDomains`, editing the
 * document text rather than regenerating it so nothing else in the file moves.
 * An emptied list takes the whole `discovery` block with it, which is what the
 * schema means by "no discovery".
 */
export function removeGrant(documentText: string, target: string): string {
  const document = parseDocument(documentText);
  const spec = document.get("spec");
  if (!isMap(spec)) return documentText;
  const discovery = spec.get("discovery");
  if (!isMap(discovery)) return documentText;
  const grants = discovery.get("allowedNeedsDomains");
  if (!isSeq(grants)) return documentText;
  const remaining = grants.items.filter((item) => String(item) !== target);
  if (remaining.length === grants.items.length) return documentText;
  if (remaining.length === 0) spec.delete("discovery");
  else grants.items = remaining;
  return document.toString();
}
