import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE PORTAL MUST NOT FETCH ANYTHING FROM THE PUBLIC INTERNET.
 *
 * It is deployed into clusters with no route out. A stylesheet from
 * fonts.googleapis.com does not fail loudly there — it hangs until the browser
 * gives up, so first paint is delayed on every page load for every operator and
 * nothing in the cluster reports why. It also tells a third party who is opening
 * an internal console.
 *
 * A build audit found exactly that in the shipped bundle: a Figtree stylesheet
 * plus two preconnects. This test reads the source template the bundle is
 * generated from, so the regression is caught before an image is built.
 */
const templatePath = join(import.meta.dirname, "..", "management", "portal", "packages", "app", "public", "index.html");

describe("the portal shell reaches no external host", () => {
  const html = readFileSync(templatePath, "utf8");

  it("references no absolute http(s) URL", () => {
    // every asset must be same-origin: the bundle, the icons, the fonts
    const external = [...html.matchAll(/(?:href|src)\s*=\s*"(https?:\/\/[^"]+)"/gu)].map((m) => m[1]);
    expect(external).toEqual([]);
  });

  it("names no known CDN, including as a preconnect", () => {
    // a preconnect is a DNS + TLS handshake to a third party even when the
    // stylesheet it warms up has been removed
    for (const host of ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com"]) {
      expect(html).not.toContain(host);
    }
  });

  it("still declares a font stack, so removing the webfont did not leave it unstyled", () => {
    expect(html).toMatch(/font-family:[^;]+sans-serif/u);
  });
});
