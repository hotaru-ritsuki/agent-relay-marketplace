import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureRoots = new Set();

afterEach(() => {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

function writeFixtureFile(root, relative) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export default true;\n");
  return file;
}

test("authoritative discovery excludes scratch tests and absent plugins", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-discovery-"));
  fixtureRoots.add(root);

  const rootTest = writeFixtureFile(root, "tests/kept.test.mjs");
  const pluginTest = writeFixtureFile(root, "plugins/cdx-relay/tests/kept.test.mjs");
  writeFixtureFile(root, ".scratch/stale.test.mjs");

  const { collectAuthoritativeTests } = await import("../tooling/run-tests.mjs");
  assert.deepEqual(collectAuthoritativeTests(root), [pluginTest, rootTest]);
  assert.equal(fs.existsSync(path.join(root, "plugins", "cursor-relay")), false);
});
