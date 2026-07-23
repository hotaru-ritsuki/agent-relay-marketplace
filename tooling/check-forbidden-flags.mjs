import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./lib/fs-walk.mjs";
import { isDirectInvocation } from "./sync-contracts.mjs";

const FORBIDDEN = [
  "--force",
  "--yolo",
  "--trust",
  "--approve-mcps",
  "--dangerously-bypass-approvals-and-sandbox",
];

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
    const found = FORBIDDEN.filter((flag) =>
      source.includes(`"${flag}"`) || source.includes(`'${flag}'`)
    );

    if (found.length) {
      violations.push({
        file,
        message: `unsafe defaults present: ${found.join(", ")}`,
      });
    }
  }

  return violations;
}

if (isDirectInvocation()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = ["cdx-relay", "cursor-relay"].flatMap((name) =>
    checkForbiddenFlags(path.join(root, "plugins", name))
  );

  if (violations.length) {
    for (const violation of violations) {
      console.error(`${violation.file}: ${violation.message}`);
    }
    process.exitCode = 1;
  }
}
