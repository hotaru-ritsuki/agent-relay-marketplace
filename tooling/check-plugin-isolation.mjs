import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./lib/fs-walk.mjs";
import { isDirectInvocation } from "./sync-contracts.mjs";

const MODULE_REFERENCE = /\b(?:import\s*(?:\(\s*["']([^"']+)["']\s*\)|(?:[^"'();]*?\s+from\s+)?["']([^"']+)["'])|export\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\))/g;

export function checkPluginIsolation(pluginDir) {
  const root = path.resolve(pluginDir);
  const violations = [];

  for (const file of listFiles(root).filter((item) => {
    const relative = path.relative(root, item).split(path.sep).join("/");
    return /\.(?:mjs|js|cjs)$/.test(item)
      && !relative.startsWith("tests/")
      && !relative.startsWith("tooling/");
  })) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(MODULE_REFERENCE)) {
      const specifier = match.slice(1).find(Boolean);
      if (!specifier.startsWith(".")) continue;

      const resolved = path.resolve(path.dirname(file), specifier);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        violations.push({
          file,
          message: `relative import resolves outside plugin: ${specifier}`,
        });
      }
    }
  }

  return violations;
}

if (isDirectInvocation({ moduleUrl: import.meta.url })) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pluginDirs = process.argv.length > 2
    ? process.argv.slice(2)
    : ["cdx-relay", "cursor-relay"].map((name) => path.join(root, "plugins", name));
  const violations = pluginDirs.flatMap(checkPluginIsolation);

  if (violations.length) {
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.message}`);
    }
    process.exitCode = 1;
  }
}
