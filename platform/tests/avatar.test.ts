import { deflateSync } from "node:zlib";
import { CONFIG_PATHS, loadAgentRegistry } from "@sre/config";
import { toRepoPath } from "@sre/config";
import { agentDetail, avatarAssetPath, AvatarError, BUILT_IN_ICONS, generateAgentChange, isManagedAvatarPath, MAX_AVATAR_BYTES, validateAvatar, type AgentDraft } from "@sre/runtime-host";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * Agent avatars.
 *
 * An avatar is presentation metadata: it changes nothing the runtime does, and
 * an Agent without one is complete. What IS worth defending is the upload — it
 * is the only place in this platform where a caller supplies bytes that end up
 * committed to Git and later served back to a browser.
 */

/** A real PNG: signature, IHDR with the given size, one IDAT, IEND. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4); // not verified by the sniffer, and not claimed to be
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(width * height * 4))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG with a SOF0 frame carrying the given size. */
function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

/**
 * A lossy WebP (VP8). The layout is exact on purpose: RIFF(4) size(4) WEBP(4)
 * "VP8 "(4) chunkSize(4) frameTag(3) syncCode(3), which puts the width at byte
 * 26 and the height at 28 of the FILE.
 */
function webp(width: number, height: number): Buffer {
  const file = Buffer.alloc(30);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(22, 4);
  file.write("WEBP", 8, "ascii");
  file.write("VP8 ", 12, "ascii");
  file.writeUInt32LE(10, 16);
  file.writeUInt16LE(width, 26);
  file.writeUInt16LE(height, 28);
  return file;
}

describe("an upload is identified by its bytes, not by what the caller claims", () => {
  it("accepts PNG, JPEG and WebP and reports the real dimensions", () => {
    expect(validateAvatar(png(256, 128))).toMatchObject({ format: "png", width: 256, height: 128 });
    expect(validateAvatar(jpeg(64, 64))).toMatchObject({ format: "jpeg", width: 64, height: 64 });
    expect(validateAvatar(webp(128, 96))).toMatchObject({ format: "webp", width: 128, height: 96 });
  });

  it("rejects an executable renamed to look like an image", () => {
    // a declared content type would have said image/png; the bytes say otherwise
    expect(() => validateAvatar(Buffer.from("MZ\\x90\\x00\\x03", "binary"))).toThrow(AvatarError);
  });

  it("rejects SVG by name, because it is a document that can carry script", () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(() => validateAvatar(svg)).toThrow(/SVG/u);
  });

  it("rejects HTML dressed as an image", () => {
    expect(() => validateAvatar(Buffer.from("<html><body>hi</body></html>"))).toThrow(AvatarError);
  });

  it("rejects a PNG signature with no IHDR, rather than reading whatever follows", () => {
    const malformed = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
    expect(() => validateAvatar(malformed)).toThrow(/malformed/u);
  });

  it("rejects a JPEG whose segments never reach a frame", () => {
    expect(() => validateAvatar(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]))).toThrow(/malformed/u);
  });

  it("rejects an empty file", () => {
    expect(() => validateAvatar(Buffer.alloc(0))).toThrow(/empty/u);
  });

  it("enforces the size bound before parsing anything", () => {
    const huge = Buffer.concat([png(64, 64), Buffer.alloc(MAX_AVATAR_BYTES)]);
    expect(() => validateAvatar(huge)).toThrow(/limit is/u);
  });

  it("rejects images too small or too large to render sensibly", () => {
    expect(() => validateAvatar(png(8, 8))).toThrow(/minimum/u);
    expect(() => validateAvatar(png(4096, 4096))).toThrow(/maximum/u);
  });
});

describe("the asset path is derived, never taken from the upload", () => {
  it("names the file after the agent and the sniffed format", () => {
    expect(avatarAssetPath("check-point", "webp")).toBe("assets/agents/check-point.webp");
    expect(avatarAssetPath("check-point", "jpeg")).toBe("assets/agents/check-point.jpg");
  });

  it("refuses an agent name that could escape the directory", () => {
    for (const hostile of ["../../etc/passwd", "a/b", "..", "Check-Point", ""]) {
      expect(() => avatarAssetPath(hostile, "png")).toThrow(AvatarError);
    }
  });

  it("recognises only paths this platform manages", () => {
    expect(isManagedAvatarPath("assets/agents/keycloak.png")).toBe(true);
    for (const outside of ["assets/agents/../../secret.png", "/etc/passwd", "platform/config/agents/keycloak.yaml", "assets/agents/keycloak.svg", "https://example.com/a.png"]) {
      expect(isManagedAvatarPath(outside)).toBe(false);
    }
  });

  it("offers a curated catalog, all of it inside the managed directory", () => {
    expect(BUILT_IN_ICONS.length).toBeGreaterThan(0);
    for (const icon of BUILT_IN_ICONS) {
      expect(icon.asset).toMatch(/^assets\/icons\/[a-z][a-z0-9-]*\.(png|jpg|webp)$/u);
    }
  });
});

describe("the change-set carries the document and the image together", () => {
  const registry = loadAgentRegistry(CONFIG_PATHS);
  const base = (): AgentDraft => {
    const detail = agentDetail(registry.listSpecialists()[0] as never, registry.catalog);
    return {
      name: detail.id, owner: detail.owner, displayName: detail.displayName,
      lifecycle: detail.lifecycle, modelTier: detail.modelTier as "small" | "large",
      modelProfile: detail.modelProfile, promptFile: detail.promptFile, prompt: detail.prompt,
      environments: detail.environments, routing: detail.routing,
      requiredRoles: detail.requiredRoles, crossDomainAllowed: detail.crossDomainAllowed,
      access: detail.access.filter(entry => entry.allowed).map(entry => ({ mcp: entry.mcp, tools: entry.allowedTools.map(tool => tool.name) })),
      limits: detail.limits,
    };
  };

  it("writes the image beside the document that references it, marked binary", () => {
    const draft = { ...base(), avatar: { upload: png(128, 128).toString("base64"), fit: "cover" as const } };
    const change = generateAgentChange(draft);

    const asset = change.files.find(file => file.path.startsWith("platform/assets/"));
    expect(asset?.path).toBe(`platform/assets/agents/${draft.name}.png`);
    // the publisher base64s utf-8 text on the way out, which would mangle bytes;
    // the encoding travels with the file so it does not have to guess
    expect(asset?.encoding).toBe("base64");

    // the DOCUMENT keeps a runtime-relative reference — that is what the runtime
    // resolves — while the change-set names the same file as Git addresses it
    const document = parseYaml(change.yaml) as { metadata: { avatar?: { asset: string; fit: string } } };
    expect(document.metadata.avatar).toEqual({ asset: `assets/agents/${draft.name}.png`, fit: "cover" });
    expect(asset?.path).toBe(toRepoPath(document.metadata.avatar?.asset as string));
  });

  it("references a built-in icon without adding a file", () => {
    const icon = BUILT_IN_ICONS[0] as { asset: string };
    const change = generateAgentChange({ ...base(), avatar: { asset: icon.asset, fit: "contain" } });
    expect(change.files.some(file => file.path.startsWith("platform/assets/"))).toBe(false);
    expect((parseYaml(change.yaml) as { metadata: { avatar?: unknown } }).metadata.avatar).toEqual({ asset: icon.asset, fit: "contain" });
  });

  it("removes the avatar when the draft says null, leaving initials behind", () => {
    const change = generateAgentChange({ ...base(), avatar: null });
    expect((parseYaml(change.yaml) as { metadata: { avatar?: unknown } }).metadata.avatar).toBeUndefined();
    expect(change.files.some(file => file.path.startsWith("platform/assets/"))).toBe(false);
  });

  it("leaves an agent with no avatar exactly as it was", () => {
    const change = generateAgentChange(base());
    expect((parseYaml(change.yaml) as { metadata: { avatar?: unknown } }).metadata.avatar).toBeUndefined();
  });

  it("refuses a draft pointing anywhere outside the managed directories", () => {
    for (const hostile of ["platform/config/agents/keycloak.yaml", "../../../etc/passwd", "https://example.com/logo.png", "assets/agents/x.svg"]) {
      expect(() => generateAgentChange({ ...base(), avatar: { asset: hostile } })).toThrow();
    }
  });

  it("refuses an upload that is not an image, before anything is written", () => {
    expect(() => generateAgentChange({ ...base(), avatar: { upload: Buffer.from("<svg/>").toString("base64") } })).toThrow(AvatarError);
    expect(() => generateAgentChange({ ...base(), avatar: { upload: "not base64!!" } })).toThrow(AvatarError);
  });
});
