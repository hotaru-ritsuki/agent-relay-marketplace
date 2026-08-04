import fs from "node:fs";
import path from "node:path";

export function existingDirectories(candidates) {
  return candidates.filter((candidate) => {
    const target = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (target?.isDirectory()) return true;
    if (target === undefined) return false;
    throw new TypeError(`Policy target exists but is not a directory: ${candidate}`);
  });
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`));
}

export function walkEntries(rootDir) {
  const root = path.resolve(rootDir);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) {
    throw new TypeError(`Filesystem walk root is not a directory: ${root}`);
  }

  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const entry = fs.lstatSync(absolute, { throwIfNoEntry: false });
      if (entry === undefined) {
        throw new TypeError(`Filesystem entry disappeared during walk: ${absolute}`);
      }
      if (entry.isSymbolicLink()) {
        const targetPath = path.resolve(
          path.dirname(absolute),
          fs.readlinkSync(absolute),
        );
        entries.push({
          path: absolute,
          type: "symlink",
          targetPath,
          targetWithinRoot: isPathWithin(root, targetPath),
        });
      } else if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        entries.push({ path: absolute, type: "file" });
      } else {
        entries.push({ path: absolute, type: "other" });
      }
    }
  }

  visit(root);
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

export function listFiles(rootDir) {
  const entries = walkEntries(rootDir);
  const unsupported = entries.find(({ type }) => type !== "file");
  if (unsupported?.type === "symlink") {
    throw new TypeError(
      `Filesystem walk refuses symbolic link: ${unsupported.path}`,
    );
  }
  if (unsupported) {
    throw new TypeError(
      `Filesystem walk refuses non-regular entry: ${unsupported.path}`,
    );
  }
  return entries.map(({ path: file }) => file);
}
