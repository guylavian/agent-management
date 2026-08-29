import { structuredPatch } from "diff";

/**
 * Structured diffs for a change-set.
 *
 * The console used to render the whole resulting file and call it a preview,
 * which left the reviewer to spot a two-line change inside ninety lines of
 * unchanged YAML. This produces what a pull request produces: per-file status,
 * counts, and hunks with surrounding context.
 *
 * The diffing itself is `jsdiff`'s `structuredPatch` — a maintained,
 * zero-dependency implementation of the same Myers diff every Git client uses.
 * An earlier draft of this file hand-rolled an LCS table, which was a worse
 * version of a solved problem.
 *
 * It is computed HERE rather than in the browser because the comparison is
 * against what is on disk, which the browser cannot see. The portal renders
 * the result and computes nothing.
 *
 * Nothing here is specific to a Git host. The same structure describes a local
 * working tree today and a GitHub or Bitbucket pull request later, because it
 * is a diff rather than a provider's response.
 */

export type FileStatus = "added" | "modified" | "deleted" | "unchanged";

export interface DiffLine {
  kind: "context" | "add" | "remove";
  /** line number in the file BEFORE the change; absent on an addition */
  before?: number;
  /** line number in the file AFTER the change; absent on a removal */
  after?: number;
  text: string;
}

export interface DiffHunk {
  beforeStart: number;
  beforeLines: number;
  afterStart: number;
  afterLines: number;
  /** `@@ -a,b +c,d @@`, so a client never has to assemble one */
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** true when the file is not text and no line diff is meaningful */
  binary: boolean;
}

export interface ChangeSetDiff {
  files: FileDiff[];
  additions: number;
  deletions: number;
  /** files that actually changed; an unchanged file is reported but not counted */
  changed: number;
}

/** Lines of context either side of a change; three is what Git shows by default. */
const CONTEXT = 3;

/**
 * Turn one jsdiff hunk into numbered lines.
 *
 * jsdiff hands back the Git wire format — a leading space, `+` or `-` on each
 * line — which is compact but leaves the client parsing strings. Expanding it
 * once here means the console renders a typed structure and never has to know
 * what a leading space means.
 */
function toLines(hunk: { oldStart: number; newStart: number; lines: string[] }): DiffLine[] {
  const lines: DiffLine[] = [];
  let before = hunk.oldStart;
  let after = hunk.newStart;

  for (const raw of hunk.lines) {
    const marker = raw.charAt(0);
    const text = raw.slice(1);
    // jsdiff emits "\ No newline at end of file" as its own line; it is a note
    // about the file, not a change to it
    if (raw.startsWith("\\")) continue;
    if (marker === "+") lines.push({ kind: "add", after: after++, text });
    else if (marker === "-") lines.push({ kind: "remove", before: before++, text });
    else lines.push({ kind: "context", before: before++, after: after++, text });
  }
  return lines;
}

/**
 * Diff one file.
 *
 * `before === undefined` means the file does not exist yet, which is an
 * ADDITION rather than a diff against an empty file. The distinction matters:
 * the console labels them differently, and a new agent should not read as a
 * hundred changed lines.
 */
export function diffFile(path: string, before: string | undefined, after: string | undefined, binary = false): FileDiff {
  const status: FileStatus =
    before === undefined && after !== undefined ? "added"
      : before !== undefined && after === undefined ? "deleted"
        : before === after ? "unchanged"
          : "modified";

  if (binary) {
    // an image has no useful line diff, and rendering its bytes would be a wall
    // of mojibake; it is reported as a changed file with no hunks
    return { path, status, additions: 0, deletions: 0, hunks: [], binary: true };
  }

  if (status === "unchanged") {
    return { path, status, additions: 0, deletions: 0, hunks: [], binary: false };
  }

  const patch = structuredPatch(path, path, before ?? "", after ?? "", undefined, undefined, { context: CONTEXT });
  const hunks: DiffHunk[] = patch.hunks.map((hunk) => {
    const lines = toLines(hunk);
    return {
      beforeStart: hunk.oldStart,
      beforeLines: hunk.oldLines,
      afterStart: hunk.newStart,
      afterLines: hunk.newLines,
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      lines,
    };
  });

  return {
    path,
    status,
    additions: hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length, 0),
    deletions: hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "remove").length, 0),
    hunks,
    binary: false,
  };
}

/** Roll a set of file diffs into the summary the console shows at the top. */
export function summarise(files: FileDiff[]): ChangeSetDiff {
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    changed: files.filter((file) => file.status !== "unchanged").length,
  };
}
