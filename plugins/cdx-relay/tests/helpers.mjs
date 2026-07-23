import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { resolveStateDir } from "../scripts/lib/state.mjs";

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

export function trackChild(child) {
  trackedChildren.add(child);
  child.once("exit", () => trackedChildren.delete(child));
  return child;
}

export async function cleanupTrackedChildren() {
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

export function resolveTestCommand(command) {
  if (process.platform !== "win32" || path.isAbsolute(command)) {
    return { command, shell: false };
  }
  if (command === "node") {
    return { command: process.execPath, shell: false };
  }
  if (command === "git") {
    return { command: "git.exe", shell: false };
  }
  return { command, shell: true };
}

export function run(command, args, options = {}) {
  const invocation = options.shell === undefined
    ? resolveTestCommand(command)
    : { command, shell: options.shell };
  const result = spawnSync(invocation.command, args, {
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

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
