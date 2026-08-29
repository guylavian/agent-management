/**
 * The Telemetry port.
 *
 * Optional, unlike the Sanitizer: a host that exports no spans loses
 * observability, not a security property, so the engine defaults to a no-op
 * rather than refusing to run.
 *
 * Attribute values are scalars only. The engine never places a raw subject, a
 * credential, a prompt, a tool argument or a tool payload in an attribute; where
 * a subject is needed it is hashed first (see ./subject.ts).
 */
export type SpanAttributes = Record<string, string | number | boolean>;

export interface Telemetry {
  span<T>(name: string, attributes: SpanAttributes, action: () => Promise<T>): Promise<T>;
  counter(name: string, value?: number): void;
}

export const noopTelemetry: Telemetry = {
  span: async (_name, _attributes, action) => action(),
  counter: () => {},
};
