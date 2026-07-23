import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./lib/fs-walk.mjs";

function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
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
  for (const pluginDir of pluginDirs) {
    const schemaTarget = path.join(pluginDir, "schemas", "agent-relay");
    const typeTarget = path.join(pluginDir, "types");
    fs.mkdirSync(schemaTarget, { recursive: true });
    fs.mkdirSync(typeTarget, { recursive: true });
    for (const source of listFiles(schemaRoot)) {
      fs.copyFileSync(source, path.join(schemaTarget, path.basename(source)));
    }
    fs.copyFileSync(typeFile, path.join(typeTarget, "relay.d.ts"));
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
