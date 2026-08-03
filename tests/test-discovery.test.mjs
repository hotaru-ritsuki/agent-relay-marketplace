import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectAuthoritativeTests,
  runAuthoritativeTests,
} from "../tooling/run-tests.mjs";

const fixtureRoots = new Set();

afterEach(() => {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

function writeFixtureFile(root, relative, source = "export default true;\n") {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}

test("authoritative discovery excludes scratch tests and absent plugins", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-discovery-"));
  fixtureRoots.add(root);

  const rootTest = writeFixtureFile(root, "tests/kept.test.mjs");
  const pluginTest = writeFixtureFile(root, "plugins/cdx-relay/tests/kept.test.mjs");
  writeFixtureFile(root, ".scratch/stale.test.mjs");

  assert.deepEqual(collectAuthoritativeTests(root), [pluginTest, rootTest]);
  assert.equal(fs.existsSync(path.join(root, "plugins", "cursor-relay")), false);
});

test("authoritative runner executes a shell-sensitive test path literally", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runner-&-"));
  fixtureRoots.add(root);
  const marker = path.join(root, "shell-sensitive-ran.txt");
  writeFixtureFile(root, "tests/kept & literal.test.mjs", [
    'import fs from "node:fs";',
    'import test from "node:test";',
    `test("literal path executes", () => fs.writeFileSync(${JSON.stringify(marker)}, "ran"));`,
    "",
  ].join("\n"));

  assert.equal(runAuthoritativeTests({ repoRoot: root }), 0);
  assert.equal(fs.readFileSync(marker, "utf8"), "ran");
});

test("authoritative runner returns the failing child test status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runner-failure-"));
  fixtureRoots.add(root);
  writeFixtureFile(root, "tests/failing.test.mjs", [
    'import test from "node:test";',
    'test("expected fixture failure", () => { throw new Error("fixture failure"); });',
    "",
  ].join("\n"));

  assert.equal(runAuthoritativeTests({ repoRoot: root }), 1);
});
