import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  assertSupervisorHealthy as assertSharedSupervisorHealthy,
  cleanupTrackedChildren as cleanupSharedSupervisor,
  installSupervisorTeardown as installSharedSupervisorTeardown,
  run as runSharedSupervisor,
  spawnTracked as spawnSharedSupervisor
} from "./process-supervisor/index.mjs";

process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-plugin-cc-tests-")
);
delete process.env.CODEX_COMPANION_SESSION_ID;

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

function normalizeInvocation(command, args = [], options = {}) {
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

export const run = (...args) =>
  runSharedSupervisor(normalizeInvocation(...args));

export const spawnTracked = (...args) =>
  spawnSharedSupervisor(normalizeInvocation(...args));

export const cleanupTrackedChildren = () => cleanupSharedSupervisor();

export const assertSupervisorHealthy = () => assertSharedSupervisorHealthy();

export function installSupervisorTeardown(afterHook) {
  installSharedSupervisorTeardown(afterHook);
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
