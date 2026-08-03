import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("root package fixes the runtime floor and license", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(
    pkg.scripts.test,
    "node tooling/run-tests.mjs",
  );
});

test("root license is Apache-2.0", () => {
  const license = fs.readFileSync(new URL("../../LICENSE", import.meta.url), "utf8");
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0, January 2004/);
});
