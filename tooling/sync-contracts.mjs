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

function assertUnchangedDirectory(pluginRoot, expected) {
  const current = snapshotSafeDirectory(pluginRoot, expected.path);
  if (!sameIdentity(expected.identity, current.identity)) {
    throw new TypeError(
      `Contract sync destination changed during publication: ${expected.path}`,
    );
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
  const root = snapshotSafeDirectory(canonical, canonical);
  if (!sameIdentity(after, root.identity)) {
    throw new TypeError(`Contract sync plugin root changed during validation: ${pluginDir}`);
  }
  return root;
}

function assertUnchangedPluginRoot(pluginRoot) {
  const current = snapshotSafeDirectory(pluginRoot.path, pluginRoot.path);
  if (!sameIdentity(pluginRoot.identity, current.identity)) {
    throw new TypeError(
      `Contract sync plugin root changed during publication: ${pluginRoot.path}`,
    );
  }
  return current;
}

function snapshotChildDirectory(pluginRoot, target) {
  assertUnchangedPluginRoot(pluginRoot);
  const entry = fs.lstatSync(target, { throwIfNoEntry: false });
  if (entry === undefined) return undefined;
  if (entry.isSymbolicLink()) throw linkedDestinationError(target);
  if (!entry.isDirectory()) {
    throw new TypeError(`Contract sync destination is not a directory: ${target}`);
  }
  const snapshot = snapshotSafeDirectory(pluginRoot.path, target);
  assertUnchangedPluginRoot(pluginRoot);
  return snapshot;
}

function assertUnchangedChildDirectory(pluginRoot, target, expected) {
  assertUnchangedPluginRoot(pluginRoot);
  const current = fs.lstatSync(target, { throwIfNoEntry: false });
  if (expected === undefined) {
    if (current !== undefined) {
      throw new TypeError(
        `Contract sync destination changed during publication: ${target}`,
      );
    }
    return;
  }
  if (current?.isSymbolicLink()
      || !current?.isDirectory()
      || !sameIdentity(expected.identity, current)) {
    throw new TypeError(
      `Contract sync destination changed during publication: ${target}`,
    );
  }
  const canonical = fs.realpathSync.native(target);
  if (!isPathWithin(pluginRoot.path, canonical)) {
    throw new TypeError(`Contract sync destination escapes plugin root: ${target}`);
  }
  assertUnchangedPluginRoot(pluginRoot);
}

function assertSafeFileTarget(pluginRoot, stage, target) {
  const entry = fs.lstatSync(target, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) throw linkedDestinationError(target);
  if (entry !== undefined && !entry.isFile()) {
    throw new TypeError(`Contract sync destination is not a file: ${target}`);
  }
  if (entry !== undefined) {
    const canonical = fs.realpathSync.native(target);
    if (!isPathWithin(stage.path, canonical)) {
      throw new TypeError(`Contract sync destination escapes plugin root: ${target}`);
    }
  }
  assertUnchangedDirectory(pluginRoot.path, stage);
  return entry;
}

function ensureStagedDirectory(pluginRoot, stage, segments) {
  let current = assertUnchangedDirectory(pluginRoot.path, stage);
  for (const segment of segments) {
    const target = path.join(current.path, segment);
    const entry = fs.lstatSync(target, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw linkedDestinationError(target);
    if (entry === undefined) fs.mkdirSync(target);
    current = snapshotSafeDirectory(pluginRoot.path, target);
    assertUnchangedDirectory(pluginRoot.path, stage);
  }
  return current;
}

function replaceStagedContract(pluginRoot, stage, source, relativeTarget) {
  const segments = relativeTarget.split("/");
  const filename = segments.pop();
  const parent = ensureStagedDirectory(pluginRoot, stage, segments);
  const target = path.join(parent.path, filename);
  const existing = assertSafeFileTarget(pluginRoot, stage, target);
  if (existing !== undefined) {
    fs.unlinkSync(target);
    if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
      throw new TypeError(`Contract sync staging target could not be removed: ${target}`);
    }
  }
  assertUnchangedDirectory(pluginRoot.path, parent);
  assertUnchangedDirectory(pluginRoot.path, stage);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const written = assertSafeFileTarget(pluginRoot, stage, target);
  if (!written?.isFile()) {
    throw new TypeError(`Contract sync staging file disappeared: ${target}`);
  }
  assertUnchangedDirectory(pluginRoot.path, parent);
  assertUnchangedPluginRoot(pluginRoot);
}

function assertUnchangedSourceEntry(source, expected) {
  const current = fs.lstatSync(source, { throwIfNoEntry: false });
  if (!current || !sameIdentity(expected, current)) {
    throw new TypeError(`Contract sync source changed during copy: ${source}`);
  }
}

function copyEntryWithoutDereference(pluginRoot, stage, source, destination) {
  const entry = fs.lstatSync(source, { throwIfNoEntry: false });
  if (!entry) {
    throw new TypeError(`Contract sync source disappeared during copy: ${source}`);
  }
  if (fs.lstatSync(destination, { throwIfNoEntry: false }) !== undefined) {
    throw new TypeError(`Contract sync staging entry already exists: ${destination}`);
  }

  if (entry.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(source);
    const followed = process.platform === "win32"
      ? fs.statSync(source, { throwIfNoEntry: false })
      : undefined;
    const linkType = followed?.isDirectory() ? "junction" : "file";
    fs.symlinkSync(linkTarget, destination, linkType);
  } else if (entry.isDirectory()) {
    fs.mkdirSync(destination, { mode: entry.mode });
    for (const name of fs.readdirSync(source).sort()) {
      copyEntryWithoutDereference(
        pluginRoot,
        stage,
        path.join(source, name),
        path.join(destination, name),
      );
    }
  } else if (entry.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } else {
    throw new TypeError(`Contract sync cannot preserve unsupported entry: ${source}`);
  }

  assertUnchangedSourceEntry(source, entry);
  const copied = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!copied
      || copied.isSymbolicLink() !== entry.isSymbolicLink()
      || copied.isDirectory() !== entry.isDirectory()
      || copied.isFile() !== entry.isFile()) {
    throw new TypeError(`Contract sync staging entry changed during copy: ${destination}`);
  }
  assertUnchangedDirectory(pluginRoot.path, stage);
}

function copyDirectoryContents(pluginRoot, source, stage) {
  assertUnchangedChildDirectory(pluginRoot, source.path, source);
  for (const name of fs.readdirSync(source.path).sort()) {
    assertUnchangedChildDirectory(pluginRoot, source.path, source);
    copyEntryWithoutDereference(
      pluginRoot,
      stage,
      path.join(source.path, name),
      path.join(stage.path, name),
    );
    assertUnchangedDirectory(pluginRoot.path, stage);
  }
  assertUnchangedChildDirectory(pluginRoot, source.path, source);
}

function createOwnedStage(pluginRoot, stagePath) {
  assertUnchangedPluginRoot(pluginRoot);
  if (fs.lstatSync(stagePath, { throwIfNoEntry: false }) !== undefined) {
    throw new TypeError(`Contract sync staging path already exists: ${stagePath}`);
  }
  fs.mkdirSync(stagePath, { mode: 0o700 });
  const stage = snapshotSafeDirectory(pluginRoot.path, stagePath);
  assertUnchangedPluginRoot(pluginRoot);
  return stage;
}

function assertOwnedEntry(target, expectedIdentity, description) {
  const current = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!current || !sameIdentity(expectedIdentity, current)) {
    throw new TypeError(`Contract sync ${description} changed: ${target}`);
  }
  return current;
}

function removeOwnedDirectory(pluginRoot, owned, description) {
  assertUnchangedPluginRoot(pluginRoot);
  const current = fs.lstatSync(owned.path, { throwIfNoEntry: false });
  if (current === undefined) return;
  if (current.isSymbolicLink()
      || !current.isDirectory()
      || !sameIdentity(owned.identity, current)) {
    throw new TypeError(`Contract sync ${description} changed: ${owned.path}`);
  }
  try {
    fs.rmSync(owned.path, {
      force: false,
      maxRetries: 2,
      recursive: true,
      retryDelay: 10,
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (fs.lstatSync(owned.path, { throwIfNoEntry: false }) !== undefined) {
    throw new TypeError(`Contract sync ${description} was not removed: ${owned.path}`);
  }
  assertUnchangedPluginRoot(pluginRoot);
}

function movePublishedStageBack(pluginRoot, childPath, stage) {
  assertUnchangedPluginRoot(pluginRoot);
  assertOwnedEntry(childPath, stage.identity, "published directory");
  if (fs.lstatSync(stage.path, { throwIfNoEntry: false }) !== undefined) {
    throw new TypeError(`Contract sync staging path changed: ${stage.path}`);
  }
  fs.renameSync(childPath, stage.path);
  const restored = snapshotSafeDirectory(pluginRoot.path, stage.path);
  if (!sameIdentity(stage.identity, restored.identity)) {
    throw new TypeError(`Contract sync staging identity changed: ${stage.path}`);
  }
  assertUnchangedPluginRoot(pluginRoot);
}

function restoreMovedEntry(pluginRoot, childPath, backupPath, movedIdentity) {
  assertUnchangedPluginRoot(pluginRoot);
  assertOwnedEntry(backupPath, movedIdentity, "backup entry");
  if (fs.lstatSync(childPath, { throwIfNoEntry: false }) !== undefined) {
    throw new TypeError(
      `Contract sync destination changed before rollback: ${childPath}`,
    );
  }
  fs.renameSync(backupPath, childPath);
  assertOwnedEntry(childPath, movedIdentity, "restored entry");
  assertUnchangedPluginRoot(pluginRoot);
}

function publicationFailure(childPath, error, recoveryErrors) {
  return new AggregateError(
    [error, ...recoveryErrors],
    `Contract sync failed while publishing ${childPath}: ${error.message}`,
  );
}

function publishChildDirectory(pluginRoot, childName, updateStage) {
  const childPath = path.join(pluginRoot.path, childName);
  const original = snapshotChildDirectory(pluginRoot, childPath);
  const token = `${process.pid}.${randomUUID()}`;
  const stagePath = path.join(pluginRoot.path, `.${childName}.${token}.stage`);
  const backupPath = path.join(pluginRoot.path, `.${childName}.${token}.backup`);
  if (fs.lstatSync(backupPath, { throwIfNoEntry: false }) !== undefined) {
    throw new TypeError(`Contract sync backup path already exists: ${backupPath}`);
  }

  const stage = createOwnedStage(pluginRoot, stagePath);
  let moved = false;
  let movedIdentity;
  let published = false;
  try {
    if (original) copyDirectoryContents(pluginRoot, original, stage);
    updateStage(stage);
    assertUnchangedDirectory(pluginRoot.path, stage);
    assertUnchangedChildDirectory(pluginRoot, childPath, original);

    if (original) {
      fs.renameSync(childPath, backupPath);
      moved = true;
      movedIdentity = fs.lstatSync(backupPath, { throwIfNoEntry: false });
      if (movedIdentity?.isSymbolicLink()
          || !movedIdentity?.isDirectory()
          || !sameIdentity(original.identity, movedIdentity)) {
        throw new TypeError(
          `Contract sync destination changed during publication: ${childPath}`,
        );
      }
      assertUnchangedPluginRoot(pluginRoot);
    }

    fs.renameSync(stage.path, childPath);
    published = true;
    const current = snapshotSafeDirectory(pluginRoot.path, childPath);
    if (!sameIdentity(stage.identity, current.identity)) {
      throw new TypeError(
        `Contract sync published directory changed during validation: ${childPath}`,
      );
    }
    assertUnchangedPluginRoot(pluginRoot);
  } catch (error) {
    const recoveryErrors = [];
    if (published) {
      try {
        movePublishedStageBack(pluginRoot, childPath, stage);
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    }
    if (moved && movedIdentity) {
      try {
        restoreMovedEntry(pluginRoot, childPath, backupPath, movedIdentity);
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    }
    try {
      removeOwnedDirectory(pluginRoot, stage, "staging directory");
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    throw publicationFailure(childPath, error, recoveryErrors);
  }

  if (moved) {
    try {
      removeOwnedDirectory(
        pluginRoot,
        { path: backupPath, identity: movedIdentity },
        "backup directory",
      );
    } catch (error) {
      throw publicationFailure(childPath, error, []);
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
  const schemaFiles = listFiles(schemaRoot);
  const typeFile = path.join(rootDir, "contracts", "types", "relay.d.ts");
  for (const pluginDir of existingDirectories(pluginDirs)) {
    const pluginRoot = canonicalPluginRoot(pluginDir);
    publishChildDirectory(pluginRoot, "schemas", (stage) => {
      for (const source of schemaFiles) {
        replaceStagedContract(
          pluginRoot,
          stage,
          source,
          `agent-relay/${path.basename(source)}`,
        );
      }
    });
    publishChildDirectory(pluginRoot, "types", (stage) => {
      replaceStagedContract(pluginRoot, stage, typeFile, "relay.d.ts");
    });
    assertUnchangedPluginRoot(pluginRoot);
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
