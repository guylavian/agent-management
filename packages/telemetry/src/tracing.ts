import { context, propagation, trace, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

let sdk: NodeSDK | undefined;

export async function initializeTelemetry(options: { exporter: "console" | "otlp" | "none"; endpoint?: string; serviceName: string }): Promise<void> {
  if (options.exporter === "none") return;
  // OTLP export is batched/non-blocking so span export never sits on the request
  // path; console stays synchronous for readable local dev output.
  const processor = options.exporter === "console"
    ? new SimpleSpanProcessor(new ConsoleSpanExporter())
    : new BatchSpanProcessor(new OTLPTraceExporter({ url: options.endpoint }));
  sdk = new NodeSDK({ serviceName: options.serviceName, spanProcessors: [processor] });
  sdk.start();
}

export async function shutdownTelemetry(): Promise<void> { await sdk?.shutdown(); }

/** Continue the caller's W3C trace context (traceparent/tracestate headers) so one distributed trace spans Manager and Specialist processes. */
export async function withExtractedContext<T>(carrier: Record<string, string | string[] | undefined>, action: () => Promise<T>): Promise<T> {
  return context.with(propagation.extract(context.active(), carrier), action);
}

export async function withSpan<T>(name: string, attributes: Attributes, action: () => Promise<T>): Promise<T> {
  const tracer = trace.getTracer("sre-agent-platform", "0.1.0");
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await context.with(trace.setSpan(context.active(), span), action);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally { span.end(); }
  });
}
