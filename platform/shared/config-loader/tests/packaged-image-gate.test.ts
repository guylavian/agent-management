import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadAppConfig } from "../src/index.ts";

/**
 * A PACKAGED IMAGE MUST BE TOLD WHICH ENVIRONMENT IT IS IN.
 *
 * `env` defaults to `local` and every client defaults to `mock`, and the
 * "production forbids mocks" check runs only after that default has been
 * applied — so `loadAppConfig({})` returns a fully mocked configuration. That is
 * right for a developer running from a checkout, and dangerous for the shipped
 * artifact: a Job, an alternate chart, or an emergency manifest that omits
 * SRE_ENV starts the production image with a mock IdP, a mock ToolHive and a
 * mock delegation authority, and nothing in the process objects.
 *
 * Removing the default would break every local invocation to defend against a
 * case that only exists in the image, so the IMAGE is what carries the
 * requirement: the Dockerfile sets SRE_PACKAGED_IMAGE, and a packaged runtime
 * must be told explicitly where it is running.
 */
const packaged = { SRE_PACKAGED_IMAGE: "1" };

describe("a packaged image refuses to guess its environment", () => {
  it("fails closed when SRE_ENV is absent", () => {
    expect(() => loadAppConfig({ ...packaged })).toThrow(ConfigValidationError);
  });

  it("names the variable it needs, so the failure is actionable", () => {
    expect(() => loadAppConfig({ ...packaged })).toThrow(/SRE_ENV/u);
  });

  it("fails closed on an environment it does not recognise", () => {
    // a typo must not silently fall back to the permissive default
    expect(() => loadAppConfig({ ...packaged, SRE_ENV: "prod" })).toThrow(ConfigValidationError);
  });

  it("starts when the environment is stated, even if that environment permits mocks", () => {
    // local IS a legitimate answer for a packaged image — the cluster under
    // certification runs exactly that. The requirement is that it was stated.
    const config = loadAppConfig({ ...packaged, SRE_ENV: "local" });
    expect(config.env).toBe("local");
  });

  it("leaves a working tree alone: no marker, no requirement", () => {
    expect(loadAppConfig({}).env).toBe("local");
  });
});
