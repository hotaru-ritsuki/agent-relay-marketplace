import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APPROVED_TEST_ROOTS = [
  "tests",
  "plugins/cdx-relay/tests",
  "plugins/cursor-relay/tests",
];

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectTestFiles(testRoot) {
  const tests = [];
  const entries = fs.readdirSync(testRoot, { withFileTypes: true })
    .sort((left, right) => comparePaths(left.name, right.name));

  for (const entry of entries) {
    const entryPath = path.join(testRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TypeError(`Authoritative test manifest rejects symlink: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      tests.push(...collectTestFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      tests.push(entryPath);
    }
  }

  return tests;
}

export function collectAuthoritativeTests(repoRoot) {
  const root = path.resolve(repoRoot);
  const tests = [];

  for (const relativeRoot of APPROVED_TEST_ROOTS) {
    const testRoot = path.join(root, ...relativeRoot.split("/"));
    const stats = fs.lstatSync(testRoot, { throwIfNoEntry: false });
    if (stats === undefined) continue;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new TypeError(`Authoritative test root is not a regular directory: ${testRoot}`);
    }
    tests.push(...collectTestFiles(testRoot));
  }

  return tests.sort(comparePaths);
}

export function runAuthoritativeTests({ repoRoot, nodeArgs = [] }) {
  const root = path.resolve(repoRoot);
  const testFiles = collectAuthoritativeTests(root);
  if (testFiles.length === 0) {
    throw new Error(`No authoritative tests found beneath ${root}`);
  }

  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--test-timeout=600000",
    ...nodeArgs,
    ...testFiles,
  ], {
    cwd: root,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = runAuthoritativeTests({ repoRoot: process.cwd() });
  if (exitCode !== 0) process.exitCode = exitCode;
}
