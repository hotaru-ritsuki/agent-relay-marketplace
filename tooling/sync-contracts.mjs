import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existingDirectories, listFiles } from "./lib/fs-walk.mjs";

function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`));
}

function linkedDestinationError(target) {
  return new TypeError(`Contract sync refuses linked destination: ${target}`);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function snapshotSafeDirectory(pluginRoot, target) {
  const before = fs.lstatSync(target, { throwIfNoEntry: false });
  if (before?.isSymbolicLink()) throw linkedDestinationError(target);
  if (!before?.isDirectory()) {
    throw new TypeError(`Contract sync destination is not a directory: ${target}`);
  }
  const canonical = fs.realpathSync.native(target);
  if (!isPathWithin(pluginRoot, canonical)) {
    throw new TypeError(`Contract sync destination escapes plugin root: ${target}`);
  }
  const after = fs.lstatSync(target, { throwIfNoEntry: false });
  if (after?.isSymbolicLink()) throw linkedDestinationError(target);
  if (!after?.isDirectory() || !sameIdentity(before, after)) {
    throw new TypeError(`Contract sync destination changed during validation: ${target}`);
  }
  return { path: canonical, identity: after };
}

function assertSafeDirectory(pluginRoot, target) {
  return snapshotSafeDirectory(pluginRoot, target).path;
}

function assertUnchangedDirectory(pluginRoot, expected) {
  const current = snapshotSafeDirectory(pluginRoot, expected.path);
  if (!sameIdentity(expected.identity, current.identity)) {
    throw new TypeError(
      `Contract sync destination changed during publication: ${expected.path}`,
    );
  }
  return current;
}

function ensureSafeDirectory(pluginRoot, segments) {
  let current = assertSafeDirectory(pluginRoot, pluginRoot);
  for (const segment of segments) {
    const target = path.join(current, segment);
    const entry = fs.lstatSync(target, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw linkedDestinationError(target);
    if (entry === undefined) fs.mkdirSync(target);
    current = assertSafeDirectory(pluginRoot, target);
  }
  return current;
}

function canonicalPluginRoot(pluginDir) {
  const before = fs.lstatSync(pluginDir, { throwIfNoEntry: false });
  if (before?.isSymbolicLink()) throw linkedDestinationError(pluginDir);
  if (!before?.isDirectory()) {
    throw new TypeError(`Contract sync plugin root is not a directory: ${pluginDir}`);
  }
  const canonical = fs.realpathSync.native(pluginDir);
  const after = fs.lstatSync(pluginDir, { throwIfNoEntry: false });
  if (after?.isSymbolicLink()) throw linkedDestinationError(pluginDir);
  if (!after?.isDirectory() || !sameIdentity(before, after)) {
    throw new TypeError(`Contract sync plugin root changed during validation: ${pluginDir}`);
  }
  return assertSafeDirectory(canonical, canonical);
}

function assertSafeFileTarget(pluginRoot, target) {
  const entry = fs.lstatSync(target, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) throw linkedDestinationError(target);
  if (entry !== undefined && !entry.isFile()) {
    throw new TypeError(`Contract sync destination is not a file: ${target}`);
  }
  if (entry !== undefined) {
    const canonical = fs.realpathSync.native(target);
    if (!isPathWithin(pluginRoot, canonical)) {
      throw new TypeError(`Contract sync destination escapes plugin root: ${target}`);
    }
  }
  return entry;
}

function assertUnchangedFileTarget(pluginRoot, target, expected) {
  const current = assertSafeFileTarget(pluginRoot, target);
  if (!current || !sameIdentity(expected, current)) {
    throw new TypeError(`Contract sync destination changed during publication: ${target}`);
  }
  return current;
}

function copyContractFile(source, pluginRoot, directory, filename) {
  const parent = snapshotSafeDirectory(pluginRoot, directory);
  const target = path.join(parent.path, filename);
  const staged = path.join(
    parent.path,
    `.${filename}.${process.pid}.${randomUUID()}.tmp`,
  );
  let stagedIdentity;

  assertSafeFileTarget(pluginRoot, target);
  try {
    assertUnchangedDirectory(pluginRoot, parent);
    fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
    stagedIdentity = assertSafeFileTarget(pluginRoot, staged);
    if (!stagedIdentity) {
      throw new TypeError(`Contract sync staging file disappeared: ${staged}`);
    }

    assertUnchangedDirectory(pluginRoot, parent);
    assertUnchangedFileTarget(pluginRoot, staged, stagedIdentity);
    assertSafeFileTarget(pluginRoot, target);
    assertUnchangedDirectory(pluginRoot, parent);
    fs.renameSync(staged, target);
    assertUnchangedDirectory(pluginRoot, parent);
    assertUnchangedFileTarget(pluginRoot, target, stagedIdentity);
  } finally {
    if (stagedIdentity) {
      assertUnchangedDirectory(pluginRoot, parent);
      const remaining = fs.lstatSync(staged, { throwIfNoEntry: false });
      if (remaining !== undefined) {
        if (!remaining.isFile() || !sameIdentity(stagedIdentity, remaining)) {
          throw new TypeError(
            `Contract sync staging file changed during publication: ${staged}`,
          );
        }
        fs.unlinkSync(staged);
      }
    }
  }
}

export function isDirectInvocation({
  argvPath = process.argv[1],
  moduleUrl = import.meta.url,
  platform = process.platform
} = {}) {
  if (!argvPath) return false;
  const invokedPath = canonicalPath(argvPath);
  const modulePath = canonicalPath(fileURLToPath(moduleUrl));
  return platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
}

export function syncContracts({ rootDir, pluginDirs }) {
  const schemaRoot = path.join(rootDir, "contracts", "schemas");
  const typeFile = path.join(rootDir, "contracts", "types", "relay.d.ts");
  for (const pluginDir of existingDirectories(pluginDirs)) {
    const pluginRoot = canonicalPluginRoot(pluginDir);
    const schemaTarget = ensureSafeDirectory(
      pluginRoot,
      ["schemas", "agent-relay"],
    );
    const typeTarget = ensureSafeDirectory(pluginRoot, ["types"]);
    for (const source of listFiles(schemaRoot)) {
      copyContractFile(
        source,
        pluginRoot,
        schemaTarget,
        path.basename(source),
      );
    }
    copyContractFile(typeFile, pluginRoot, typeTarget, "relay.d.ts");
  }
}

if (isDirectInvocation()) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  syncContracts({
    rootDir,
    pluginDirs: [
      path.join(rootDir, "plugins", "cdx-relay"),
      path.join(rootDir, "plugins", "cursor-relay")
    ]
  });
}
