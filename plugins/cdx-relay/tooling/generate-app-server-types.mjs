import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function resolveDefaultCodexInvocation() {
  if (process.platform !== "win32") {
    return { command: "codex", argsPrefix: [] };
  }

  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const shimPath = path.join(directory, "codex.cmd");
    const entrypoint = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(shimPath) && fs.existsSync(entrypoint)) {
      const siblingNode = path.join(directory, "node.exe");
      return {
        command: fs.existsSync(siblingNode) ? siblingNode : process.execPath,
        argsPrefix: [entrypoint]
      };
    }
  }

  return { command: "codex.exe", argsPrefix: [] };
}

export function generateAppServerTypes({
  codexCommand,
  outputDir,
  spawnSyncImpl = spawnSync
}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const invocation = codexCommand
    ? { command: codexCommand, argsPrefix: [] }
    : resolveDefaultCodexInvocation();
  const result = spawnSyncImpl(
    invocation.command,
    [...invocation.argsPrefix, "app-server", "generate-ts", "--out", outputDir],
    { encoding: "utf8", shell: false, stdio: "inherit" }
  );

  if (result.error) {
    throw new Error(`Unable to start Codex type generation: ${result.error.message}`, {
      cause: result.error
    });
  }
  if (result.status !== 0) {
    throw new Error(`Codex type generation failed with status ${result.status}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  generateAppServerTypes({
    outputDir: path.join(pluginRoot, ".generated", "app-server-types")
  });
}
