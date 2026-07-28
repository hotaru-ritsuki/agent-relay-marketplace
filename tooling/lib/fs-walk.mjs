import fs from "node:fs";
import path from "node:path";

export function existingDirectories(candidates) {
  return candidates.filter((candidate) =>
    fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true
  );
}

export function listFiles(rootDir) {
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const absolute = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
