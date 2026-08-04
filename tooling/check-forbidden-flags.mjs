import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existingDirectories, listFiles } from "./lib/fs-walk.mjs";
import { isDirectInvocation } from "./sync-contracts.mjs";

const FORBIDDEN = [
  "--force",
  "--yolo",
  "--trust",
  "--approve-mcps",
  "--dangerously-bypass-approvals-and-sandbox",
  "danger-full-access",
];
const DISABLED_SANDBOX = /--sandbox\s*=\s*disabled|["'`]--sandbox["'`]\s*,\s*["'`]disabled["'`]/;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".generated",
  ".git",
  ".scratch",
  ".superpowers",
  ".tmp",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "temp",
  "tmp",
  "vendor",
]);

function containsStructuredValue(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsStructuredValue(item, expected));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) =>
      containsStructuredValue(item, expected)
    );
  }
  return false;
}

function isScannable(root, file) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (relative.startsWith("tooling/")
      || ["CHANGELOG.md", "NOTICE", "PROVENANCE.md"].includes(relative)) {
    return false;
  }
  if (relative.startsWith("tests/")) {
    return /\.(?:mjs|js|cjs)$/.test(file);
  }
  return /\.(?:md|json|mjs|js|cjs)$/.test(file);
}

function isIgnoredDirectory({ name, relativePath }) {
  return relativePath === "tooling" || IGNORED_DIRECTORY_NAMES.has(name);
}

export function checkForbiddenFlags(pluginDir) {
  const root = path.resolve(pluginDir);
  const violations = [];

  const files = listFiles(root, {
    shouldDescend: (directory) => !isIgnoredDirectory(directory),
  });
  for (const file of files) {
    if (!isScannable(root, file)) continue;
    const source = fs.readFileSync(file, "utf8");
    let structured;
    if (path.extname(file).toLowerCase() === ".json") {
      try {
        structured = JSON.parse(source);
      } catch (error) {
        violations.push({
          file,
          message: `structured safety scan failed: ${error.message}`,
        });
        continue;
      }
    }

    const found = FORBIDDEN.filter((flag) =>
      flag === "danger-full-access" && structured !== undefined
        ? containsStructuredValue(structured, flag)
        : source.includes(flag)
    );
    if (DISABLED_SANDBOX.test(source)) found.push("--sandbox=disabled");

    if (found.length) {
      violations.push({
        file,
        message: `unsafe defaults present: ${found.join(", ")}`,
      });
    }
  }

  return violations;
}

if (isDirectInvocation({ moduleUrl: import.meta.url })) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pluginDirs = process.argv.length > 2
    ? process.argv.slice(2)
    : existingDirectories(
        ["cdx-relay", "cursor-relay"].map((name) =>
          path.join(root, "plugins", name)
        )
      );
  const violations = pluginDirs.flatMap(checkForbiddenFlags);

  if (violations.length) {
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.message}`);
    }
    process.exitCode = 1;
  }
}
