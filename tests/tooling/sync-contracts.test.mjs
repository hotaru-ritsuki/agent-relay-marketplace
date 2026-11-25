import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
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

function createFileLink(target, link) {
  fs.symlinkSync(target, link, "file");
  assert.equal(
    fs.lstatSync(link).isSymbolicLink(),
    true,
    `expected a real file link at ${link}`,
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
    assert.deepEqual(
      listFiles(root),
      [path.join(inRootTarget, "inside.txt")],
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("listFiles skips POSIX socket entries while walkEntries exposes them", {
  skip: process.platform === "win32",
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-file-special-"));
  const socketPath = path.join(temp, "control.sock");
  const regularFile = path.join(temp, "regular.txt");
  const server = net.createServer();
  fs.writeFileSync(regularFile, "regular");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    assert.deepEqual(
      fsWalk.walkEntries(temp),
      [
        { path: socketPath, type: "other" },
        { path: regularFile, type: "file" },
      ],
    );
    assert.deepEqual(listFiles(temp), [regularFile]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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

test("syncContracts replaces existing regular contract files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-update-"));
  try {
    const rootDir = fileURLToPath(new URL("../..", import.meta.url));
    const pluginDir = path.join(temp, "cdx-relay");
    const schemaTarget = path.join(
      pluginDir,
      "schemas",
      "agent-relay",
      "common.schema.json",
    );
    const typeTarget = path.join(pluginDir, "types", "relay.d.ts");
    fs.mkdirSync(path.dirname(schemaTarget), { recursive: true });
    fs.mkdirSync(path.dirname(typeTarget), { recursive: true });
    fs.writeFileSync(schemaTarget, "stale-schema");
    fs.writeFileSync(typeTarget, "stale-types");

    syncContracts({ rootDir, pluginDirs: [pluginDir] });

    assert.deepEqual(
      fs.readFileSync(schemaTarget),
      fs.readFileSync(path.join(rootDir, "contracts", "schemas", "common.schema.json")),
    );
    assert.deepEqual(
      fs.readFileSync(typeTarget),
      fs.readFileSync(path.join(rootDir, "contracts", "types", "relay.d.ts")),
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("syncContracts preserves unrelated directory entries without following links", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-preserve-"));
  try {
    const rootDir = fileURLToPath(new URL("../..", import.meta.url));
    const pluginDir = path.join(temp, "cdx-relay");
    const typesDir = path.join(pluginDir, "types");
    const schemasDir = path.join(pluginDir, "schemas");
    const outsideFile = path.join(temp, "outside-target");
    fs.mkdirSync(path.join(typesDir, "nested"), { recursive: true });
    fs.mkdirSync(path.join(schemasDir, "custom"), { recursive: true });
    fs.writeFileSync(path.join(typesDir, "notes.txt"), "keep-types");
    fs.writeFileSync(path.join(typesDir, "nested", "notes.txt"), "keep-nested");
    fs.writeFileSync(path.join(schemasDir, "custom", "keep.json"), "keep-schema");
    fs.writeFileSync(outsideFile, "outside-sentinel");
    const preservedLink = path.join(typesDir, "outside-link");
    createFileLink(outsideFile, preservedLink);

    syncContracts({ rootDir, pluginDirs: [pluginDir] });

    assert.equal(fs.readFileSync(path.join(typesDir, "notes.txt"), "utf8"), "keep-types");
    assert.equal(
      fs.readFileSync(path.join(typesDir, "nested", "notes.txt"), "utf8"),
      "keep-nested",
    );
    assert.equal(
      fs.readFileSync(path.join(schemasDir, "custom", "keep.json"), "utf8"),
      "keep-schema",
    );
    assert.equal(fs.lstatSync(preservedLink).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(preservedLink), outsideFile);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-sentinel");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("syncContracts never follows a staged target swapped to an outside link", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-swap-"));
  try {
    const rootDir = fileURLToPath(new URL("../..", import.meta.url));
    const pluginDir = path.join(temp, "cdx-relay");
    const target = path.join(pluginDir, "types", "relay.d.ts");
    const outsideFile = path.join(temp, "outside-target");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "stale-types");
    fs.writeFileSync(outsideFile, "outside-sentinel");

    const originalCopyFileSync = fs.copyFileSync.bind(fs);
    let injected = false;
    function injectTargetSwap(destination) {
      const destinationPath = path.resolve(destination);
      const isStagedTypeTarget = path.basename(destinationPath) === "relay.d.ts"
        && path.dirname(destinationPath) !== path.dirname(path.resolve(target))
        && destinationPath.startsWith(`${path.resolve(pluginDir)}${path.sep}`);
      if (injected || !isStagedTypeTarget) return;
      createFileLink(outsideFile, destinationPath);
      injected = true;
    }
    t.mock.method(fs, "copyFileSync", (source, destination, mode) => {
      injectTargetSwap(destination);
      return originalCopyFileSync(source, destination, mode);
    });

    let failure;
    try {
      syncContracts({ rootDir, pluginDirs: [pluginDir] });
    } catch (error) {
      failure = error;
    }

    assert.equal(injected, true, "the test must inject the final-target swap");
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-sentinel");
    assert.match(failure?.message ?? "", /contract sync/i);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "stale-types");
    assert.deepEqual(
      listFiles(path.dirname(target)).map((file) => path.basename(file)),
      ["relay.d.ts"],
    );
    assert.deepEqual(fs.readdirSync(pluginDir).sort(), ["schemas", "types"]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

for (const [childName, contractRelative] of [
  ["schemas", "agent-relay/common.schema.json"],
  ["types", "relay.d.ts"],
]) {
  test(`syncContracts never publishes through a swapped ${childName} parent`, (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-parent-swap-"));
    try {
      const rootDir = fileURLToPath(new URL("../..", import.meta.url));
      const pluginDir = path.join(temp, "cdx-relay");
      const childDir = path.join(pluginDir, childName);
      const contractTarget = path.join(childDir, ...contractRelative.split("/"));
      const outsideDir = path.join(temp, `outside-${childName}`);
      const outsideTarget = path.join(outsideDir, ...contractRelative.split("/"));
      fs.mkdirSync(path.dirname(contractTarget), { recursive: true });
      fs.writeFileSync(contractTarget, "outside-sentinel");
      fs.writeFileSync(path.join(childDir, "keep.txt"), "keep-entry");

      const originalRenameSync = fs.renameSync.bind(fs);
      let injected = false;
      t.mock.method(fs, "renameSync", (source, destination) => {
        const sourcePath = path.resolve(source);
        const destinationPath = path.resolve(destination);
        const sourceIsChildEntry = sourcePath === path.resolve(childDir);
        const sourceIsCurrentStagingFile = sourcePath.startsWith(
          `${path.resolve(childDir)}${path.sep}`,
        ) && destinationPath === path.resolve(contractTarget);
        if (!injected && (sourceIsChildEntry || sourceIsCurrentStagingFile)) {
          originalRenameSync(childDir, outsideDir);
          createDirectoryLink(outsideDir, childDir);
          injected = true;
        }
        return originalRenameSync(source, destination);
      });

      let failure;
      try {
        syncContracts({ rootDir, pluginDirs: [pluginDir] });
      } catch (error) {
        failure = error;
      }

      assert.equal(injected, true, "the test must inject the destination-parent swap");
      assert.equal(fs.readFileSync(outsideTarget, "utf8"), "outside-sentinel");
      assert.equal(fs.readFileSync(path.join(outsideDir, "keep.txt"), "utf8"), "keep-entry");
      assert.match(failure?.message ?? "", /contract sync/i);
      assert.equal(fs.lstatSync(childDir).isSymbolicLink(), true);
      assert.deepEqual(
        fs.readdirSync(pluginDir).sort(),
        childName === "schemas" ? ["schemas"] : ["schemas", "types"],
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}

for (const linkedComponent of ["schemas", "types"]) {
  test(`syncContracts refuses an existing ${linkedComponent} directory link`, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-link-"));
    try {
      const rootDir = fileURLToPath(new URL("../..", import.meta.url));
      const pluginDir = path.join(temp, "cdx-relay");
      const outside = path.join(temp, "outside");
      fs.mkdirSync(pluginDir);
      fs.mkdirSync(outside);
      createDirectoryLink(outside, path.join(pluginDir, linkedComponent));
      let failure;

      try {
        syncContracts({ rootDir, pluginDirs: [pluginDir] });
      } catch (error) {
        failure = error;
      }

      assert.match(
        failure?.message ?? "",
        /contract sync refuses linked destination/i,
      );
      assert.deepEqual(listFiles(outside), []);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}

for (const linkedTarget of [
  "types/relay.d.ts",
  "schemas/agent-relay/common.schema.json",
]) {
  test(`syncContracts refuses the linked final target ${linkedTarget}`, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-target-link-"));
    try {
      const rootDir = fileURLToPath(new URL("../..", import.meta.url));
      const pluginDir = path.join(temp, "cdx-relay");
      const destination = path.join(pluginDir, ...linkedTarget.split("/"));
      const outsideFile = path.join(temp, "outside-target");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(outsideFile, "outside-sentinel");
      createFileLink(outsideFile, destination);
      let failure;

      try {
        syncContracts({ rootDir, pluginDirs: [pluginDir] });
      } catch (error) {
        failure = error;
      }

      assert.match(
        failure?.message ?? "",
        /contract sync refuses linked destination/i,
      );
      assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-sentinel");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
