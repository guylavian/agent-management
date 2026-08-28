import { readFileSync, writeFileSync } from "node:fs";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { name?: string; version?: string; license?: string }> };
const rows = Object.entries(lock.packages)
  .filter(([path, item]) => path.startsWith("node_modules/") && item.version !== undefined)
  .map(([path, item]) => ({ name: item.name ?? path.replace(/^node_modules\//u, ""), version: item.version as string, license: item.license ?? "See package metadata" }))
  .sort((a, b) => a.name.localeCompare(b.name));
const output = ["# Locked npm package inventory", "", "Generated from `package-lock.json` by `npm run gen:supply-chain`. Integrity hashes and resolved artifacts remain authoritative in the lockfile.", "", "| Package | Version | License |", "|---|---:|---|", ...rows.map((row) => `| \`${row.name}\` | \`${row.version}\` | ${row.license} |`), ""].join("\n");
writeFileSync("deploy/supply-chain/npm/npm-packages.md", output, "utf8");
