/**
 * The Model port.
 *
 * The engine owns this vocabulary because a message and a tool schema are
 * primitives of agent execution, not of any one provider. Nothing here mentions
 * OpenAI, Anthropic, vLLM or a transport; a host adapts its own client to this
 * shape at the composition root.
 *
 * A model is UNTRUSTED. Everything it returns — content, tool name, arguments —
 * is data to be validated by deterministic runtime code before it has any
 * effect. The engine never lets a model decide whether an operation is allowed.
 */

export interface ModelToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  /** on an assistant message: the tool calls the model made, replayed to the provider */
  toolCalls?: ModelToolCall[];
}

export interface ModelRequest {
  /** the Agent's logical model profile; the host resolves it to a served model */
  model: string;
  messages: ModelMessage[];
  tools?: ModelToolSchema[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  content?: string;
  toolCalls?: ModelToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface Model {
  chat(request: ModelRequest): Promise<ModelResponse>;
}
