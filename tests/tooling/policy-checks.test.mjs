import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPluginIsolation } from "../../tooling/check-plugin-isolation.mjs";
import { checkForbiddenFlags } from "../../tooling/check-forbidden-flags.mjs";

function fixture(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-"));
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, "runtime.mjs"), source);
  return root;
}

test("isolation rejects imports that leave the plugin", () => {
  const violations = checkPluginIsolation(fixture('import "../../contracts/runtime.mjs";'));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /outside plugin/);
});

test("safety scan rejects unsafe default flags", () => {
  const violations = checkForbiddenFlags(fixture('const defaults = ["--force", "--trust"];'));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /--force/);
  assert.match(violations[0].message, /--trust/);
});

test("safe runtime sources pass both policies", () => {
  const root = fixture('import "./local.mjs"; const args = ["--sandbox", "enabled"];');
  fs.writeFileSync(path.join(root, "scripts", "local.mjs"), "export default true;");
  assert.deepEqual(checkPluginIsolation(root), []);
  assert.deepEqual(checkForbiddenFlags(root), []);
});
