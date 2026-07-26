import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

import { resolveStateDir } from "../scripts/lib/state.mjs";
import {
  assertSupervisorHealthy as assertSharedSupervisorHealthy,
  cleanupTrackedChildren as cleanupSharedSupervisor,
  createProcessSupervisor,
  run as runSharedSupervisor,
  shutdown as shutdownSharedSupervisor,
  spawnTracked as spawnSharedSupervisor
} from "./process-supervisor/index.mjs";

process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-plugin-cc-tests-"),
);
delete process.env.CODEX_COMPANION_SESSION_ID;

const trackedChildren = new Set();
const trackedProcessIds = new Set();

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function trackProcessId(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || trackedProcessIds.has(pid)) {
    return;
  }
  trackedProcessIds.add(pid);
  const watcher = setInterval(() => {
    if (!trackedProcessIds.has(pid) || !isProcessRunning(pid)) {
      trackedProcessIds.delete(pid);
      clearInterval(watcher);
    }
  }, 50);
  watcher.unref();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function registerRecordedChildren(cwd) {
  if (!cwd) return;
  const stateDir = resolveStateDir(cwd);
  const broker = readJson(path.join(stateDir, "broker.json"));
  trackProcessId(broker?.pid);

  const state = readJson(path.join(stateDir, "state.json"));
  for (const job of state?.jobs ?? []) {
    if (job?.status === "queued" || job?.status === "running") {
      trackProcessId(job.pid);
    }
  }
}

function terminateProcessTree(pid) {
  if (!isProcessRunning(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process completed between the liveness check and termination.
    }
  }
}

/**
 * @deprecated Use spawnTracked. This compatibility seam provides only the
 * cooperative minimum guarantee.
 */
export function trackChild(
  child,
  { minimumGuarantee = "cooperative" } = {}
) {
  if (minimumGuarantee !== "cooperative") {
    throw new TypeError("trackChild supports only the cooperative guarantee.");
  }
  trackedChildren.add(child);
  child.once("exit", () => trackedChildren.delete(child));
  return child;
}

async function legacyCleanupTrackedChildren() {
  for (const child of trackedChildren) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  trackedChildren.clear();
  for (const pid of trackedProcessIds) {
    terminateProcessTree(pid);
  }
  trackedProcessIds.clear();
}

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

function isValidatedNpmCli(filePath) {
  if (typeof filePath !== "string" ||
      path.basename(filePath).toLowerCase() !== "npm-cli.js") {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024 * 1024) {
      return false;
    }
    const descriptor = fs.openSync(filePath, "r");
    try {
      const sample = Buffer.alloc(Math.min(stat.size, 4096));
      fs.readSync(descriptor, sample, 0, sample.length, 0);
      return !sample.includes(0);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

function resolveWindowsNpmCli(environment) {
  if (isValidatedNpmCli(environment.npm_execpath)) {
    return fs.realpathSync.native(environment.npm_execpath);
  }
  const pathValue = environment.Path ?? environment.PATH ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;
    const directory = path.resolve(entry.replace(/^"|"$/g, ""));
    const candidates = [
      path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(directory, "npm-cli.js")
    ];
    for (const candidate of candidates) {
      if (isValidatedNpmCli(candidate)) {
        return fs.realpathSync.native(candidate);
      }
    }
  }
  throw new Error(
    "Could not resolve a validated npm-cli.js from npm_execpath or PATH."
  );
}

export function resolveTestCommand(
  command,
  platform = process.platform,
  environment = process.env
) {
  if (platform !== "win32" || path.isAbsolute(command)) {
    return { command, shell: false };
  }
  if (command === "node") {
    return { command: process.execPath, shell: false };
  }
  if (command === "git") {
    return { command: "git.exe", shell: false };
  }
  if (command === "npm") {
    const npmCli = resolveWindowsNpmCli(environment);
    return { command: process.execPath, argsPrefix: [npmCli], shell: false };
  }
  return { command, shell: true };
}

function legacyRun(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const invocation = options.shell === undefined
    ? resolveTestCommand(command, platform, options.env ?? process.env)
    : { command, shell: options.shell };
  if (platform === "win32") {
    return runSharedSupervisor(command, args, options);
  }
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(invocation.command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: invocation.shell,
    windowsHide: true
  });
  registerRecordedChildren(options.cwd);
  return result;
}

function normalizeRunArgs(command, args = [], options = {}) {
  if (command && typeof command === "object" && !Array.isArray(command)) {
    if (command.shell !== undefined && command.shell !== false) {
      throw new TypeError("Supervised commands require shell: false.");
    }
    return { ...command, shell: false };
  }
  const invocation = resolveTestCommand(
    command,
    options.platform ?? process.platform,
    options.env ?? process.env
  );
  if (invocation.shell !== false) {
    throw new TypeError(
      `Supervised test command ${command} must resolve without a shell.`
    );
  }
  return {
    ...options,
    command: invocation.command,
    args: [...(invocation.argsPrefix ?? []), ...args],
    shell: false
  };
}

function normalizeSpawnArgs(command, args = [], options = {}) {
  if (command && typeof command === "object" && !Array.isArray(command)) {
    if (command.shell !== undefined && command.shell !== false) {
      throw new TypeError("Supervised commands require shell: false.");
    }
    return { ...command, shell: false };
  }
  const invocation = resolveTestCommand(
    command,
    options.platform ?? process.platform,
    options.env ?? process.env
  );
  if (invocation.shell !== false) {
    throw new TypeError(
      `Supervised test command ${command} must resolve without a shell.`
    );
  }
  return {
    ...options,
    command: invocation.command,
    args: [...(invocation.argsPrefix ?? []), ...args],
    shell: false
  };
}

export function compatibilityBackend({
  spawnTrackedImpl = async (command, args, options) =>
    trackChild(spawn(command, args, options))
} = {}) {
  return {
    async probe() {
      return {
        available: true,
        capabilities: {
          platform: process.platform,
          backend: "child-process",
          mode: "cooperative",
          containment: "cooperative",
          cleanupProof: "registered-drained",
          supportsDetachedDescendants: false
        }
      };
    },
    async launch(spec) {
      const child = await spawnTrackedImpl(
        spec.command,
        spec.args ?? [],
        spec
      );
      let spawnError;
      const root = new Promise((resolve) => {
        child.once("error", (error) => {
          spawnError = error;
        });
        child.once("exit", (status, signal) => {
          resolve({
            backend: "child-process",
            status,
            signal,
            stdout: undefined,
            stderr: undefined,
            error: spawnError
          });
        });
        child.once("close", (status, signal) => {
          if (spawnError) {
            resolve({
              backend: "child-process",
              status,
              signal,
              stdout: undefined,
              stderr: undefined,
              error: spawnError
            });
          }
        });
      });
      return {
        child,
        pid: child.pid,
        root,
        kill(signal) {
          const stopped = child.kill(signal);
          return { backend: "child-process", stopped };
        },
        cleanup: async () => {
          await legacyCleanupTrackedChildren();
          return {
            backend: "child-process",
            level: "registered-drained"
          };
        }
      };
    },
    async cleanupAll() {
      await legacyCleanupTrackedChildren();
      return {
        backend: "child-process",
        level: "registered-drained"
      };
    },
    async shutdown() {
      await legacyCleanupTrackedChildren();
      return { stopped: true };
    }
  };
}

const testSupervisor = createProcessSupervisor({
  minimumGuarantee: "cooperative",
  backendFactories: [compatibilityBackend]
});

export const run = (...args) => {
  const options = args[2] ?? {};
  if (options.spawnSyncImpl ||
      (options.platform !== undefined && options.platform !== process.platform)) {
    return legacyRun(...args);
  }
  const spec = normalizeRunArgs(...args);
  const result = process.platform === "win32" && options.shell !== true
    ? runSharedSupervisor(spec)
    : testSupervisor.run(spec);
  registerRecordedChildren(spec.cwd);
  return result;
};
export const spawnTracked = (...args) => process.platform === "win32"
  ? spawnSharedSupervisor(...args)
  : testSupervisor.spawnTracked(normalizeSpawnArgs(...args));
export const cleanupTrackedChildren = async () => {
  await testSupervisor.cleanupAll();
  return process.platform === "win32"
    ? cleanupSharedSupervisor()
    : { cleaned: true };
};
export const assertSupervisorHealthy = () => {
  testSupervisor.assertHealthy();
  if (process.platform === "win32") assertSharedSupervisorHealthy();
};

export function installSupervisorTeardown(afterHook) {
  afterHook(async () => {
    const shutdownErrors = [];
    if (process.platform === "win32") {
      try {
        await shutdownSharedSupervisor();
      } catch (error) {
        shutdownErrors.push(error);
      }
    }
    try {
      await testSupervisor.shutdown();
    } catch (error) {
      shutdownErrors.push(error);
    }
    if (process.platform === "win32") {
      try {
        assertSharedSupervisorHealthy();
      } catch (error) {
        shutdownErrors.push(error);
      }
    }
    testSupervisor.assertHealthy();
    if (shutdownErrors.length > 0) throw shutdownErrors[0];
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
