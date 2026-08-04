import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPluginIsolation } from "../../tooling/check-plugin-isolation.mjs";
import { checkForbiddenFlags } from "../../tooling/check-forbidden-flags.mjs";
import { existingDirectories } from "../../tooling/lib/fs-walk.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ISOLATION_CLI = path.resolve(TEST_DIR, "../../tooling/check-plugin-isolation.mjs");
const SAFETY_CLI = path.resolve(TEST_DIR, "../../tooling/check-forbidden-flags.mjs");
const fixtureRoots = new Set();

afterEach(() => {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

function fixture(source, filename = "runtime.mjs") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-"));
  fixtureRoots.add(root);
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

function createDirectoryLink(target, link) {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
}

test("default policy targets skip absent planned plugin directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-targets-"));
  fixtureRoots.add(root);
  const cdxRelay = path.join(root, "cdx-relay");
  const cursorRelay = path.join(root, "cursor-relay");
  fs.mkdirSync(cdxRelay);

  assert.deepEqual(existingDirectories([cdxRelay, cursorRelay]), [cdxRelay]);
});

test("default policy targets fail closed for an existing regular file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-targets-"));
  fixtureRoots.add(root);
  const fileTarget = path.join(root, "cursor-relay");
  fs.writeFileSync(fileTarget, "");

  assert.throws(
    () => existingDirectories([fileTarget]),
    /policy target exists but is not a directory/i,
  );
});

test("default policy targets fail closed for a symlink to a regular file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-targets-"));
  fixtureRoots.add(root);
  const fileTarget = path.join(root, "cursor-relay-file");
  const linkTarget = path.join(root, "cursor-relay");
  fs.writeFileSync(fileTarget, "");
  fs.symlinkSync(fileTarget, linkTarget, "file");

  assert.throws(
    () => existingDirectories([linkTarget]),
    /policy target exists but is not a directory/i,
  );
});

test("default policy targets fail closed for a broken link", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-targets-"));
  fixtureRoots.add(root);
  const linkTarget = path.join(root, "cursor-relay");
  fs.symlinkSync("missing-target", linkTarget);

  assert.throws(
    () => existingDirectories([linkTarget]),
    /policy target exists but is not a directory/i,
  );
});

test("default policy targets fail closed for a directory link", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-targets-"));
  fixtureRoots.add(root);
  const directoryTarget = path.join(root, "cursor-relay-target");
  const linkTarget = path.join(root, "cursor-relay");
  fs.mkdirSync(directoryTarget);
  createDirectoryLink(directoryTarget, linkTarget);

  assert.throws(
    () => existingDirectories([linkTarget]),
    /policy target exists but is not a directory/i,
  );
});

test("default policy targets include and scan a future plugin once it exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-targets-"));
  fixtureRoots.add(root);
  const cdxRelay = path.join(root, "cdx-relay");
  const cursorRelay = path.join(root, "cursor-relay");
  fs.mkdirSync(cdxRelay);
  writeFixtureFile(cursorRelay, "scripts/runtime.mjs", 'const defaults = ["--force"];');

  const targets = existingDirectories([cdxRelay, cursorRelay]);
  assert.deepEqual(targets, [cdxRelay, cursorRelay]);
  assert.deepEqual(
    targets.flatMap(checkForbiddenFlags).map(({ message }) => message),
    ["unsafe defaults present: --force"],
  );
});

test("isolation rejects imports that leave the plugin", () => {
  const violations = checkPluginIsolation(fixture('import "../../contracts/runtime.mjs";'));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /outside plugin/);
});

test("isolation accepts Windows-equivalent path casing inside the plugin", {
  skip: process.platform !== "win32",
}, () => {
  const root = fixture("");
  const casedRootName = path.basename(root).toUpperCase();
  const specifier = `../../${casedRootName}/local.mjs`;

  writeFixtureFile(root, "scripts/runtime.mjs", `import "${specifier}";`);
  assert.deepEqual(checkPluginIsolation(root), []);
});

test("isolation rejects a sibling whose name starts with the plugin name", () => {
  const root = fixture("");
  const siblingName = `${path.basename(root)}-other`;
  const specifier = `../../${siblingName}/local.mjs`;

  writeFixtureFile(root, "scripts/runtime.mjs", `import "${specifier}";`);
  assert.deepEqual(
    checkPluginIsolation(root).map(({ message }) => message),
    [`relative import resolves outside plugin: ${specifier}`],
  );
});

test("safety scan rejects unsafe default flags", () => {
  const violations = checkForbiddenFlags(fixture('const defaults = ["--force", "--trust"];'));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /--force/);
  assert.match(violations[0].message, /--trust/);
});

test("safety CLI exits 1 for danger-full-access in structured JSON", () => {
  const root = fixture('const args = ["--sandbox", "enabled"];');
  writeFixtureFile(
    root,
    "config/runtime.json",
    JSON.stringify({ provider: { sandbox: "danger-full-access" } }),
  );

  const result = runCli(SAFETY_CLI, root);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /danger-full-access/);
});

test("safety CLI exits 1 for forbidden launch flags in executable tests", () => {
  const root = fixture('const args = ["--sandbox", "enabled"];');
  writeFixtureFile(
    root,
    "tests/process-supervisor/launch.test.mjs",
    'const launchArgs = ["--yolo"];',
  );

  const result = runCli(SAFETY_CLI, root);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--yolo/);
});

test("safety CLI fails closed when structured JSON cannot be parsed", () => {
  const root = fixture('const args = ["--sandbox", "enabled"];');
  writeFixtureFile(root, "config/runtime.json", '{"sandbox":');

  const result = runCli(SAFETY_CLI, root);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /structured safety scan/i);
});

test("safety CLI ignores forbidden content in generated dependency build and temp trees", () => {
  const root = fixture('const args = ["--sandbox", "enabled"];');
  for (const [relative, source] of [
    [".generated/runtime.mjs", 'const args = ["--force"];'],
    [".scratch/stale.test.mjs", 'const args = ["--yolo"];'],
    [".superpowers/cache/runtime.cjs", 'const args = ["--trust"];'],
    [".tmp/fixture.json", '{"sandbox":"danger-full-access"}'],
    [".worktrees/stale/runtime.js", 'const args = ["--approve-mcps"];'],
    ["build/bundle.js", 'const args = ["--force"];'],
    ["coverage/result.json", '{"sandbox":"danger-full-access"}'],
    ["dist/bundle.js", 'const args = ["--yolo"];'],
    ["node_modules/vendor/package.json", '{"sandbox":"danger-full-access"}'],
    ["temp/fixture.mjs", 'const args = ["--trust"];'],
    ["tmp/fixture.cjs", 'const args = ["--approve-mcps"];'],
    ["vendor/dependency.js", 'const args = ["--force"];'],
  ]) {
    writeFixtureFile(root, relative, source);
  }

  const result = runCli(SAFETY_CLI, root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("safety CLI scans authoritative nested paths with generated-looking basenames", () => {
  const root = fixture('const args = ["--sandbox", "enabled"];');
  for (const [relative, source] of [
    ["scripts/vendor/launcher.mjs", 'const args = ["--force"];'],
    ["tests/tmp/launcher.test.mjs", 'const args = ["--yolo"];'],
    ["config/build/runtime.json", '{"sandbox":"danger-full-access"}'],
    ["scripts/dist/launcher.cjs", 'const args = ["--trust"];'],
    ["config/.generated/runtime.json", '{"args":["--approve-mcps"]}'],
  ]) {
    writeFixtureFile(root, relative, source);
  }

  const result = runCli(SAFETY_CLI, root);

  assert.equal(result.status, 1, result.stderr);
  for (const relative of [
    "scripts/vendor/launcher.mjs",
    "tests/tmp/launcher.test.mjs",
    "config/build/runtime.json",
    "scripts/dist/launcher.cjs",
    "config/.generated/runtime.json",
  ]) {
    assert.match(
      result.stderr,
      new RegExp(relative.replaceAll("/", "[\\\\/]")),
      `expected the safety CLI to scan ${relative}`,
    );
  }
});

test("safety CLI prunes ignored trees before malformed JSON and links", () => {
  const root = fixture('const args = ["--sandbox", "enabled"];');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-outside-"));
  fixtureRoots.add(outside);
  writeFixtureFile(root, "node_modules/vendor/package.json", '{"sandbox":');
  writeFixtureFile(root, ".generated/broken.json", '{"sandbox":');
  writeFixtureFile(outside, "unsafe.mjs", 'const args = ["--yolo"];');
  const link = path.join(root, "dist", "linked-vendor");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  createDirectoryLink(outside, link);

  const result = runCli(SAFETY_CLI, root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
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
  ["namespace re-export", (specifier) => `export * as relay from "${specifier}";`, "runtime.mjs"],
  ["CommonJS require", (specifier) => `require("${specifier}");`, "runtime.cjs"],
];
const PARSER_MODULE_REFERENCE_FORMS = [
  [
    "dynamic import with comment and options",
    (specifier) => `await import(/* comment */ "${specifier}", { with: { type: "json" } });`,
    "runtime.mjs",
    "../../outside.json",
  ],
  [
    "CommonJS require with comment",
    (specifier) => `require(/* comment */ "${specifier}");`,
    "runtime.cjs",
    "../../outside.cjs",
  ],
  [
    "Unicode namespace re-export",
    (specifier) => `export * as π from "${specifier}";`,
    "runtime.mjs",
    "../../outside.mjs",
  ],
  [
    "no-substitution template dynamic import",
    (specifier) => `await import(\`${specifier}\`);`,
    "runtime.mjs",
    "../../outside.mjs",
  ],
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

for (const [name, sourceFor, filename, outsideSpecifier] of PARSER_MODULE_REFERENCE_FORMS) {
  test(`isolation rejects outside-plugin ${name}`, () => {
    const violations = checkPluginIsolation(
      fixture(sourceFor(outsideSpecifier), filename),
    );
    assert.deepEqual(
      violations.map(({ message }) => message),
      [`relative import resolves outside plugin: ${outsideSpecifier}`],
    );
  });

  test(`isolation accepts in-plugin ${name}`, () => {
    assert.deepEqual(
      checkPluginIsolation(fixture(sourceFor("./local.mjs"), filename)),
      [],
    );
  });
}

test("isolation fails closed for malformed JavaScript", () => {
  const root = fixture("const broken = ;", "runtime.js");
  const file = path.join(root, "scripts", "runtime.js");
  let violations;

  assert.doesNotMatch(fs.readFileSync(ISOLATION_CLI, "utf8"), /\.parseDiagnostics\b/);
  assert.doesNotThrow(() => {
    violations = checkPluginIsolation(root);
  });
  assert.deepEqual(
    violations.map((violation) => ({
      file: violation.file,
      message: violation.message.replace(/ at \d+:\d+$/, ""),
    })),
    [{
      file,
      message: "JavaScript syntax error prevents isolation scan: Expression expected.",
    }],
  );
});

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
