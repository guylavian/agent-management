import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MockOidcClient } from "../src/oidc.ts";

/**
 * A RESTART IS NOT A KEY ROTATION.
 *
 * The mock used to generate a fresh RSA key per process, so every restart
 * silently invalidated every token it had issued and the first symptom was a
 * 401 in a different process. With the key persisted, a token from the previous
 * process still verifies in the next one.
 */
const dir = mkdtempSync(join(tmpdir(), "mock-oidc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const settings = { issuer: "https://mock-idp.sre.local", audience: "sre-assistant", mockKeyFile: join(dir, "nested", "key.pem") };

describe("MockOidcClient with a persisted key", () => {
  it("verifies a token issued by a previous process", async () => {
    const before = new MockOidcClient(settings);
    const token = await before.issueTestToken("alice");
    const after = new MockOidcClient(settings);
    await expect(after.verify(token, "r1")).resolves.toMatchObject({ subject: "alice" });
  });

  it("still rotates per process when no file is configured", async () => {
    const token = await new MockOidcClient({ issuer: settings.issuer, audience: settings.audience }).issueTestToken("alice");
    await expect(new MockOidcClient({ issuer: settings.issuer, audience: settings.audience }).verify(token, "r1")).rejects.toThrow();
  });

  it("starts anyway when the key file cannot be written", async () => {
    const client = new MockOidcClient({ ...settings, mockKeyFile: "/proc/nope/key.pem" });
    await expect(client.verify(await client.issueTestToken("alice"), "r1")).resolves.toMatchObject({ subject: "alice" });
  });
});
