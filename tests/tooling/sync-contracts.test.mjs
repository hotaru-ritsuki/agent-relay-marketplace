import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fsWalk from "../../tooling/lib/fs-walk.mjs";
import * as syncModule from "../../tooling/sync-contracts.mjs";

const { syncContracts } = syncModule;
const { listFiles } = fsWalk;

function createDirectoryLink(target, link) {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(
    fs.lstatSync(link).isSymbolicLink(),
    true,
    `expected a real directory link at ${link}`,
  );
}

test("listFiles orders paths by ordinal code units", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-file-order-"));
  try {
    const upper = path.join(temp, "Z.schema.json");
    const lower = path.join(temp, "a.schema.json");
    fs.writeFileSync(upper, "");
    fs.writeFileSync(lower, "");

    assert.deepEqual(listFiles(temp), [upper, lower]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("walkEntries reports in-root and out-of-root directory links without traversal", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-file-links-"));
  try {
    const root = path.join(temp, "root");
    const inRootTarget = path.join(root, "in-root-target");
    const outsideTarget = path.join(temp, "outside-target");
    const inRootLink = path.join(root, "in-root-link");
    const outsideLink = path.join(root, "outside-link");
    fs.mkdirSync(inRootTarget, { recursive: true });
    fs.mkdirSync(outsideTarget);
    fs.writeFileSync(path.join(inRootTarget, "inside.txt"), "inside");
    fs.writeFileSync(path.join(outsideTarget, "outside.txt"), "outside");
    createDirectoryLink(inRootTarget, inRootLink);
    createDirectoryLink(outsideTarget, outsideLink);

    assert.equal(typeof fsWalk.walkEntries, "function");
    const entries = fsWalk.walkEntries(root);
    const links = entries.filter(({ type }) => type === "symlink");

    assert.deepEqual(links, [
      {
        path: inRootLink,
        type: "symlink",
        targetPath: inRootTarget,
        targetWithinRoot: true,
      },
      {
        path: outsideLink,
        type: "symlink",
        targetPath: outsideTarget,
        targetWithinRoot: false,
      },
    ]);
    assert.equal(
      entries.some(({ path: entryPath }) =>
        entryPath === path.join(inRootLink, "inside.txt")
      ),
      false,
    );
    assert.equal(
      entries.some(({ path: entryPath }) =>
        entryPath === path.join(outsideLink, "outside.txt")
      ),
      false,
    );
    assert.throws(
      () => listFiles(root),
      /filesystem walk refuses symbolic link/i,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("isDirectInvocation matches equivalent Windows path spellings", () => {
  const moduleUrl = new URL("../../tooling/sync-contracts.mjs", import.meta.url);
  const equivalentArgvPath = fileURLToPath(moduleUrl).toUpperCase().replaceAll("\\", "/");

  assert.equal(typeof syncModule.isDirectInvocation, "function");
  assert.equal(
    syncModule.isDirectInvocation({
      argvPath: equivalentArgvPath,
      moduleUrl,
      platform: "win32"
    }),
    true
  );
});

test("syncContracts copies schemas and declarations into each plugin", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-"));
  try {
    const rootDir = fileURLToPath(new URL("../..", import.meta.url));
    const pluginDirs = [path.join(temp, "cdx-relay"), path.join(temp, "cursor-relay")];
    for (const pluginDir of pluginDirs) fs.mkdirSync(pluginDir);
    const canonicalSchemas = listFiles(path.join(rootDir, "contracts", "schemas"));
    const canonicalDeclaration = path.join(rootDir, "contracts", "types", "relay.d.ts");
    syncContracts({ rootDir, pluginDirs });

    for (const pluginDir of pluginDirs) {
      assert.deepEqual(
        fs.readFileSync(path.join(pluginDir, "types", "relay.d.ts")),
        fs.readFileSync(canonicalDeclaration)
      );
      for (const canonicalSchema of canonicalSchemas) {
        assert.deepEqual(
          fs.readFileSync(
            path.join(pluginDir, "schemas", "agent-relay", path.basename(canonicalSchema))
          ),
          fs.readFileSync(canonicalSchema)
        );
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("syncContracts updates an existing plugin without creating an absent plugin", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-absent-"));
  try {
    const rootDir = fileURLToPath(new URL("../..", import.meta.url));
    const cdxRelay = path.join(temp, "cdx-relay");
    const cursorRelay = path.join(temp, "cursor-relay");
    fs.mkdirSync(cdxRelay);

    syncContracts({ rootDir, pluginDirs: [cdxRelay, cursorRelay] });

    assert.deepEqual(
      fs.readFileSync(path.join(cdxRelay, "types", "relay.d.ts")),
      fs.readFileSync(path.join(rootDir, "contracts", "types", "relay.d.ts")),
    );
    assert.equal(fs.existsSync(cursorRelay), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
