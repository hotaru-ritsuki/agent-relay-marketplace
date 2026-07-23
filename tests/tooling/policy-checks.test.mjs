import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPluginIsolation } from "../../tooling/check-plugin-isolation.mjs";
import { checkForbiddenFlags } from "../../tooling/check-forbidden-flags.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ISOLATION_CLI = path.resolve(TEST_DIR, "../../tooling/check-plugin-isolation.mjs");
const SAFETY_CLI = path.resolve(TEST_DIR, "../../tooling/check-forbidden-flags.mjs");

function fixture(source, filename = "runtime.mjs") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-"));
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, filename), source);
  return root;
}

function runCli(script, pluginDir) {
  return spawnSync(process.execPath, [script, pluginDir], {
    encoding: "utf8",
  });
}

function writeFixtureFile(root, relative, source) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
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

const MODULE_REFERENCE_FORMS = [
  ["static import", (specifier) => `import value from "${specifier}";`, "runtime.mjs"],
  ["side-effect import", (specifier) => `import "${specifier}";`, "runtime.js"],
  ["dynamic import", (specifier) => `await import("${specifier}");`, "runtime.cjs"],
  ["named re-export", (specifier) => `export { value } from "${specifier}";`, "runtime.mjs"],
  ["star re-export", (specifier) => `export * from "${specifier}";`, "runtime.js"],
  ["CommonJS require", (specifier) => `require("${specifier}");`, "runtime.cjs"],
];
const APPROVED_UNSAFE_FLAGS = [
  "--force",
  "--yolo",
  "--trust",
  "--approve-mcps",
  "--dangerously-bypass-approvals-and-sandbox",
];

for (const [name, sourceFor, filename] of MODULE_REFERENCE_FORMS) {
  test(`isolation rejects outside-plugin ${name}`, () => {
    const specifier = "../../outside.mjs";
    const violations = checkPluginIsolation(fixture(sourceFor(specifier), filename));
    assert.deepEqual(
      violations.map(({ message }) => message),
      [`relative import resolves outside plugin: ${specifier}`],
    );
  });

  test(`isolation accepts in-plugin ${name}`, () => {
    assert.deepEqual(checkPluginIsolation(fixture(sourceFor("./local.mjs"), filename)), []);
  });
}

for (const [quoteName, source, flag] of [
  ["single-quoted", "const args = ['--force'];", "--force"],
  ["double-quoted", 'const args = ["--trust"];', "--trust"],
  ["template-quoted", "const args = [`--yolo`];", "--yolo"],
]) {
  test(`safety scan rejects ${quoteName} unsafe flags`, () => {
    const violations = checkForbiddenFlags(fixture(source));
    assert.deepEqual(
      violations.map(({ message }) => message),
      [`unsafe defaults present: ${flag}`],
    );
  });
}

test("safety scan rejects unsafe flag=value forms in approved order", () => {
  const source = APPROVED_UNSAFE_FLAGS
    .toReversed()
    .map((flag) => `\`${flag}=enabled\``)
    .join(", ");
  const violations = checkForbiddenFlags(fixture(source));
  assert.deepEqual(
    violations.map(({ message }) => message),
    [`unsafe defaults present: ${APPROVED_UNSAFE_FLAGS.join(", ")}`],
  );
});

for (const [name, source] of [
  ["equals form", 'const args = ["--sandbox=disabled"];'],
  ["adjacent arguments", "const args = ['--sandbox', `disabled`];"],
]) {
  test(`safety scan rejects disabled sandbox ${name}`, () => {
    const violations = checkForbiddenFlags(fixture(source));
    assert.deepEqual(
      violations.map(({ message }) => message),
      ["unsafe defaults present: --sandbox=disabled"],
    );
  });
}

test("safety scan treats an unsafe flag mentioned in Markdown as a violation", () => {
  const violations = checkForbiddenFlags(
    fixture("Never make --force the provider default.", "README.md"),
  );
  assert.deepEqual(
    violations.map(({ message }) => message),
    ["unsafe defaults present: --force"],
  );
});

test("isolation scan excludes tests and tooling directories", () => {
  const root = fixture('import "./local.mjs";');
  writeFixtureFile(root, "tests/unsafe.mjs", 'import "../../outside.mjs";');
  writeFixtureFile(root, "tooling/unsafe.cjs", 'require("../../outside.cjs");');
  assert.deepEqual(checkPluginIsolation(root), []);
});

test("safety scan excludes approved paths and unsupported extensions", () => {
  const root = fixture('const args = ["--sandbox", "enabled"];');
  for (const relative of [
    "tests/unsafe.js",
    "tooling/unsafe.md",
    "CHANGELOG.md",
    "NOTICE",
    "PROVENANCE.md",
    "scripts/unsafe.txt",
  ]) {
    writeFixtureFile(root, relative, "--force");
  }
  assert.deepEqual(checkForbiddenFlags(root), []);
});

test("policy violations have stable path ordering", () => {
  const isolationRoot = fixture('import "../../outside.mjs";');
  writeFixtureFile(isolationRoot, "z/unsafe.js", 'export * from "../../outside.js";');
  writeFixtureFile(isolationRoot, "a/unsafe.cjs", 'require("../../outside.cjs");');
  assert.deepEqual(
    checkPluginIsolation(isolationRoot).map(({ file }) => path.relative(isolationRoot, file)),
    [
      path.join("a", "unsafe.cjs"),
      path.join("scripts", "runtime.mjs"),
      path.join("z", "unsafe.js"),
    ],
  );

  const safetyRoot = fixture("--force");
  writeFixtureFile(safetyRoot, "z/unsafe.js", "--trust");
  writeFixtureFile(safetyRoot, "a/unsafe.cjs", "--yolo");
  assert.deepEqual(
    checkForbiddenFlags(safetyRoot).map(({ file }) => path.relative(safetyRoot, file)),
    [
      path.join("a", "unsafe.cjs"),
      path.join("scripts", "runtime.mjs"),
      path.join("z", "unsafe.js"),
    ],
  );
});

for (const [name, cli, source] of [
  ["isolation", ISOLATION_CLI, 'import "../../outside.mjs";'],
  ["safety", SAFETY_CLI, 'const defaults = ["--force"];'],
]) {
  test(`${name} CLI exits 1 for a violating plugin`, () => {
    const result = runCli(cli, fixture(source));
    assert.equal(result.status, 1, result.stderr);
  });

  test(`${name} CLI exits 0 for a safe plugin`, () => {
    const result = runCli(cli, fixture('const args = ["--sandbox", "enabled"];'));
    assert.equal(result.status, 0, result.stderr);
  });
}
