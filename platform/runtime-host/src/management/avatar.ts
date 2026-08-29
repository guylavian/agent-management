/**
 * Agent avatars: validation, naming and the change-set entry.
 *
 * An avatar is PRESENTATION METADATA. It changes nothing the runtime does —
 * not routing, not authorization, not tool access — and an Agent without one is
 * complete. The console falls back to initials, which is why nothing here is
 * required anywhere.
 *
 * The file itself lives in Git beside the Agent documents and is referenced by
 * path, never by URL and never inline. A remote URL would make rendering the
 * console depend on a third party and would leak which agents exist to whoever
 * hosts it; base64 in the document would put a megabyte of noise in every diff
 * of a file whose diffs are meant to be read.
 */

/** Formats accepted. SVG is absent deliberately — see `sniff`. */
export type AvatarFormat = "png" | "jpeg" | "webp";

/** `contain` for a product logo, `cover` for an avatar-style image. */
export type AvatarFit = "cover" | "contain";

export const MAX_AVATAR_BYTES = 1_048_576;
const MIN_EDGE = 32;
const MAX_EDGE = 2_048;

export class AvatarError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "AvatarError";
    this.reason = reason;
  }
}

export interface AvatarAsset {
  format: AvatarFormat;
  width: number;
  height: number;
  bytes: Buffer;
}

const EXTENSION: Record<AvatarFormat, string> = { png: "png", jpeg: "jpg", webp: "webp" };
export const CONTENT_TYPE: Record<AvatarFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * Identify the format from the BYTES, never from a declared content type.
 *
 * A client says what it likes; the header is what the browser will actually
 * render. Sniffing also rejects a file whose extension and contents disagree,
 * which is the shape most upload problems take.
 *
 * SVG is not a format here and is not sniffable in the same way: it is a
 * document that can carry script and external references, so accepting one
 * would mean shipping a sanitiser and being right about it forever. Raster
 * only, until something needs otherwise.
 */
function sniff(bytes: Buffer): { format: AvatarFormat; width: number; height: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    // IHDR must be the first chunk of a valid PNG; its dimensions live at 16/20
    if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") throw new AvatarError("the PNG is malformed");
    return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: "jpeg", ...jpegSize(bytes) };
  }

  if (bytes.length >= 30 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { format: "webp", ...webpSize(bytes) };
  }

  if (bytes.subarray(0, 512).toString("ascii").trimStart().startsWith("<")) {
    throw new AvatarError("SVG and other markup formats are not accepted; upload a PNG, JPEG or WebP");
  }
  throw new AvatarError("the file is not a PNG, JPEG or WebP image");
}

/** Walk the JPEG segments to a start-of-frame marker; anything else is malformed. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new AvatarError("the JPEG is malformed");
    const marker = bytes[offset + 1] as number;
    // SOF0-3, SOF5-7, SOF9-11 carry the frame dimensions; C4/C8/CC are not frames
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) throw new AvatarError("the JPEG is malformed");
    offset += 2 + length;
  }
  throw new AvatarError("the JPEG is malformed");
}

/** VP8 (lossy), VP8L (lossless) and VP8X (extended) each store size differently. */
function webpSize(bytes: Buffer): { width: number; height: number } {
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8 " && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: (bytes[24] as number) + ((bytes[25] as number) << 8) + ((bytes[26] as number) << 16) + 1,
      height: (bytes[27] as number) + ((bytes[28] as number) << 8) + ((bytes[29] as number) << 16) + 1,
    };
  }
  throw new AvatarError("the WebP is malformed");
}

/**
 * Validate an uploaded avatar.
 *
 * Order matters: the size bound is checked before anything reads the buffer, so
 * a large hostile file is rejected without being parsed.
 */
export function validateAvatar(bytes: Buffer): AvatarAsset {
  if (bytes.length === 0) throw new AvatarError("the file is empty");
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new AvatarError(`the image is ${Math.round(bytes.length / 1024)} KB; the limit is ${MAX_AVATAR_BYTES / 1024} KB`);
  }
  const { format, width, height } = sniff(bytes);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new AvatarError("the image reports no usable dimensions");
  }
  if (width < MIN_EDGE || height < MIN_EDGE) throw new AvatarError(`the image is ${width}×${height}; the minimum is ${MIN_EDGE}×${MIN_EDGE}`);
  if (width > MAX_EDGE || height > MAX_EDGE) throw new AvatarError(`the image is ${width}×${height}; the maximum is ${MAX_EDGE}×${MAX_EDGE}`);
  return { format, width, height, bytes };
}

/**
 * Where the asset lands in the repository.
 *
 * The name is DERIVED from the agent id and the sniffed format — never from the
 * uploaded filename, which is attacker-controlled and the usual way a path
 * escapes its directory. There is no separator in an agent name (the schema's
 * pattern forbids one), so the result cannot leave `assets/agents/`.
 */
export function avatarAssetPath(agentName: string, format: AvatarFormat): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(agentName)) throw new AvatarError("invalid agent name");
  return `assets/agents/${agentName}.${EXTENSION[format]}`;
}

/** True for a path this platform is willing to read and serve. */
export function isManagedAvatarPath(path: string): boolean {
  return /^assets\/agents\/[a-z][a-z0-9-]*\.(png|jpg|webp)$/u.test(path);
}

/**
 * The curated built-in catalog.
 *
 * These are the platforms this product already integrates with. Choosing one
 * writes the same `metadata.avatar` reference an upload would, so the two paths
 * differ only in where the bytes came from — and a built-in asset that has not
 * been added to the repository yet simply does not appear.
 */
export interface BuiltInIcon {
  id: string;
  label: string;
  asset: string;
  fit: AvatarFit;
}

export const BUILT_IN_ICONS: readonly BuiltInIcon[] = [
  { id: "kubernetes", label: "Kubernetes", asset: "assets/icons/kubernetes.png", fit: "contain" },
  { id: "openshift", label: "OpenShift", asset: "assets/icons/openshift.png", fit: "contain" },
  { id: "keycloak", label: "Keycloak", asset: "assets/icons/keycloak.png", fit: "contain" },
  { id: "prometheus", label: "Prometheus", asset: "assets/icons/prometheus.png", fit: "contain" },
  { id: "linux", label: "Linux", asset: "assets/icons/linux.png", fit: "contain" },
  { id: "network", label: "Network", asset: "assets/icons/network.png", fit: "contain" },
] as const;
