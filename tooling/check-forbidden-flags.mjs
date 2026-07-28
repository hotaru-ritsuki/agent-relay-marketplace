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
];
const DISABLED_SANDBOX = /--sandbox\s*=\s*disabled|["'`]--sandbox["'`]\s*,\s*["'`]disabled["'`]/;

export function checkForbiddenFlags(pluginDir) {
  const root = path.resolve(pluginDir);
  const violations = [];

  for (const file of listFiles(root).filter((item) => {
    const relative = path.relative(root, item).split(path.sep).join("/");
    return /\.(?:md|json|mjs|js|cjs)$/.test(item)
      && !relative.startsWith("tests/")
      && !relative.startsWith("tooling/")
      && !["CHANGELOG.md", "NOTICE", "PROVENANCE.md"].includes(relative);
  })) {
    const source = fs.readFileSync(file, "utf8");
    const found = FORBIDDEN.filter((flag) => source.includes(flag));
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
