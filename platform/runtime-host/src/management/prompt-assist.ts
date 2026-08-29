import type { ModelClient } from "@sre/llm";

/**
 * Drafting a system prompt with a model (TDD §29 adjacent).
 *
 * The console sends the form as the operator has it — unsaved — and gets back
 * prompt text to edit. Nothing is stored, nothing is proposed, and no pull
 * request is opened: the result lands in a textarea the operator still owns.
 *
 * TWO boundaries matter here and are enforced in code below rather than in the
 * caller.
 *
 * 1. WHAT LEAVES. `safeContext` is an allowlist. The request is projected onto
 *    a fixed set of scalar and string-array fields, so a field added to the
 *    portal's form later cannot start travelling to a model by accident. There
 *    is no branch that copies an unknown key.
 *
 * 2. WHICH MODEL. The profile is the literal `prompt-assist`, never the
 *    Agent's own. An Agent's profile is bound to what that Agent may reason
 *    over; console assistance is a platform concern and is bound separately per
 *    environment — a hosted endpoint in dev, an internal OpenAI-compatible
 *    model in an air-gapped deployment. Neither this file nor the endpoint
 *    names a vendor.
 *
 * The generated text is GUIDANCE. It cannot widen anything: the runtime's
 * authorization, allowlists, read-only posture and budgets are enforced against
 * configuration, and a prompt that claims otherwise is simply wrong, not
 * dangerous.
 */

/** The platform profile for console assistance. Never an Agent's own profile. */
export const PROMPT_ASSIST_PROFILE = "prompt-assist";

/**
 * Everything the drafter is allowed to see. Every field is either a string, a
 * number, a boolean or an array of strings — there is no shape here that could
 * carry a token, a credential or a nested object from elsewhere in the form.
 */
export interface PromptAssistContext {
  name: string;
  displayName?: string;
  description?: string;
  owner?: string;
  capabilities: string[];
  exclusions: string[];
  crossDomainAllowed: string[];
  environments: string[];
  requiredRoles: string[];
  /** MCP servers and the tools selected on each; names only, never audiences or credentials */
  access: Array<{ mcp: string; tools: string[] }>;
  readOnly: boolean;
  maxToolCalls?: number;
  maxModelTurns?: number;
  /** the current prompt, when the operator is asking for an improvement rather than a draft */
  existingPrompt?: string;
}

export class PromptAssistError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "PromptAssistError";
    this.reason = reason;
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()).slice(0, 64) : [];
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * Project an arbitrary request body onto the allowlist above.
 *
 * This is a rebuild, not a filter: the returned object is constructed field by
 * field from known keys, so anything the caller sent that is not named here
 * cannot survive. `tests/prompt-assist.test.ts` plants an API key in the body
 * and asserts it does not appear in what is sent to the model.
 */
export function safeContext(body: unknown): PromptAssistContext {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = str(input.name);
  if (name === undefined) throw new PromptAssistError("an agent name is required to draft a prompt");

  const routing = (input.routing ?? {}) as Record<string, unknown>;
  const limits = (input.limits ?? {}) as Record<string, unknown>;
  const access = Array.isArray(input.access)
    ? input.access
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
        .map((entry) => ({ mcp: str(entry.mcp) ?? "", tools: list(entry.tools) }))
        .filter((entry) => entry.mcp !== "")
        .slice(0, 32)
    : [];

  return {
    name,
    ...(str(input.displayName) === undefined ? {} : { displayName: str(input.displayName) as string }),
    ...(str(input.description) === undefined ? {} : { description: str(input.description) as string }),
    ...(str(input.owner) === undefined ? {} : { owner: str(input.owner) as string }),
    capabilities: list(routing.capabilities),
    exclusions: list(routing.exclusions),
    crossDomainAllowed: list(input.crossDomainAllowed),
    environments: list(input.environments),
    requiredRoles: list(input.requiredRoles),
    access,
    // the platform supports no writing Agent; the draft must never suggest one
    readOnly: true,
    ...(num(limits.maxToolCalls) === undefined ? {} : { maxToolCalls: num(limits.maxToolCalls) as number }),
    ...(num(limits.maxModelTurns) === undefined ? {} : { maxModelTurns: num(limits.maxModelTurns) as number }),
    ...(str(input.prompt) === undefined ? {} : { existingPrompt: (str(input.prompt) as string).slice(0, 8_000) }),
  };
}

/**
 * The instructions the drafter works under.
 *
 * These describe the contract every specialist in this platform obeys — the
 * control vocabulary, the evidence discipline, the escalation path — so the
 * draft is consistent with the runtime rather than plausible-sounding prose.
 */
const SYSTEM = [
  "You write the system prompt for one specialist agent on a read-only SRE investigation platform.",
  "Return ONLY the prompt body. No preamble, no explanation, no markdown fences around the whole answer.",
  "",
  "The prompt you write must:",
  "- state the specialist's role and the domain it owns, in the second person",
  "- state what is OUT of scope, using the exclusions given",
  "- instruct the agent to investigate using ONLY the tools listed, and to cite the evidence it collected",
  "- forbid inventing, assuming or completing tool results that were not returned",
  "- instruct it to answer `insufficient_evidence` when the evidence does not support a conclusion",
  "- instruct it to answer `needs_domain` when the request belongs to another specialist's domain",
  "- state that the agent is read-only and must never propose or attempt a mutating action",
  "- keep to roughly 200-400 words, in plain direct sentences, no headings deeper than one level",
  "",
  "Do not invent tools, servers, capabilities or limits that are not in the context.",
  "Do not restate the numeric budgets; the runtime enforces them.",
].join("\n");

function render(context: PromptAssistContext): string {
  const lines = [
    `name: ${context.name}`,
    ...(context.displayName === undefined ? [] : [`display name: ${context.displayName}`]),
    ...(context.description === undefined ? [] : [`description: ${context.description}`]),
    ...(context.owner === undefined ? [] : [`owning team: ${context.owner}`]),
    ...(context.capabilities.length === 0 ? [] : [`capabilities: ${context.capabilities.join(", ")}`]),
    ...(context.exclusions.length === 0 ? [] : [`out of scope: ${context.exclusions.join(", ")}`]),
    ...(context.crossDomainAllowed.length === 0 ? [] : [`may escalate to: ${context.crossDomainAllowed.join(", ")}`]),
    ...(context.environments.length === 0 ? [] : [`environments: ${context.environments.join(", ")}`]),
    "read-only: yes",
    "",
    "available tools:",
    ...(context.access.length === 0
      ? ["  (none selected yet)"]
      : context.access.map((entry) => `  ${entry.mcp}: ${entry.tools.length === 0 ? "(no tools selected)" : entry.tools.join(", ")}`)),
  ];

  if (context.existingPrompt !== undefined) {
    lines.push(
      "",
      "The operator already has this prompt and wants it improved. Keep what is correct,",
      "fix what conflicts with the context above, and return the full replacement:",
      "---",
      context.existingPrompt,
      "---",
    );
  }
  return lines.join("\n");
}

/**
 * Draft a system prompt for the agent described by `context`.
 *
 * Failure throws. The caller returns an error and the console leaves the
 * operator's existing prompt exactly as it was — a drafting aid that can
 * silently replace someone's work with nothing is worse than no aid.
 */
export async function draftSystemPrompt(model: ModelClient, context: PromptAssistContext, signal?: AbortSignal): Promise<string> {
  const response = await model.chat({
    // the platform profile, resolved to a served model by the environment's
    // bindings; this file names no provider and no vendor
    model: PROMPT_ASSIST_PROFILE,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: render(context) },
    ],
    ...(signal ? { signal } : {}),
  });

  const prompt = response.content?.trim();
  if (prompt === undefined || prompt === "") throw new PromptAssistError("the model returned no prompt text");
  return prompt;
}
