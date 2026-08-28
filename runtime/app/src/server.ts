import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { buildDependencies, createApp } from "./app.ts";
import { initializeTelemetry, shutdownTelemetry } from "@sre/telemetry";

const deps = buildDependencies();
await initializeTelemetry({ exporter: deps.config.telemetry.exporter, ...(deps.config.telemetry.otlpEndpoint ? { endpoint: deps.config.telemetry.otlpEndpoint } : {}), serviceName: deps.config.telemetry.serviceName });
const app = createApp(deps);
const server = app.listen(deps.config.port, "0.0.0.0");

// Optional loopback HTTPS listener for the same app. ToolHive's JWKS-fetch client
// requires an https scheme, so the manager exposes its internal JWKS over TLS here
// when a cert is configured (specialists leave these unset and stay HTTP-only).
const tlsCertFile = process.env.SRE_INTERNAL_TLS_CERT_FILE;
const tlsKeyFile = process.env.SRE_INTERNAL_TLS_KEY_FILE;
const tlsPort = process.env.SRE_INTERNAL_TLS_PORT;
const tlsServer = tlsCertFile && tlsKeyFile && tlsPort
  ? createHttpsServer({ cert: readFileSync(tlsCertFile), key: readFileSync(tlsKeyFile) }, app).listen(Number(tlsPort), "127.0.0.1")
  : undefined;

const stop = async (): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (tlsServer) await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  await shutdownTelemetry();
};
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
