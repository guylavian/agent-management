import { buildDependencies, createApp } from "./app.ts";
import { initializeTelemetry, shutdownTelemetry } from "@sre/telemetry";

const deps = buildDependencies();
await initializeTelemetry({ exporter: deps.config.telemetry.exporter, ...(deps.config.telemetry.otlpEndpoint ? { endpoint: deps.config.telemetry.otlpEndpoint } : {}), serviceName: deps.config.telemetry.serviceName });
const app = createApp(deps);
await app.listen({ port: deps.config.port, host: "0.0.0.0" });

const stop = async (): Promise<void> => { await app.close(); await shutdownTelemetry(); };
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
