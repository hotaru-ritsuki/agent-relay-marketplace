import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./lib/fs-walk.mjs";
import { isDirectInvocation } from "./sync-contracts.mjs";

const IMPORT = /\bimport\s*(?:\(\s*["']([^"']+)["']\s*\)|(?:[^"'();]*?\s+from\s+)?["']([^"']+)["'])/g;

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
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2];
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

if (isDirectInvocation()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = ["cdx-relay", "cursor-relay"].flatMap((name) =>
    checkPluginIsolation(path.join(root, "plugins", name))
  );

  if (violations.length) {
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.message}`);
    }
    process.exitCode = 1;
  }
}
