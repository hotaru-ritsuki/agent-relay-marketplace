import fs from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";

const PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 2000;

function validatePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError(`Process identity requires a positive integer pid; received ${pid}.`);
  }
}

function commandOptions(options) {
  return options.env === undefined
    ? { shell: false }
    : { shell: false, env: options.env };
}

function commandFailure(platform, pid, result) {
  const detail = result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? `exit ${result.status}`;
  return new Error(`Could not capture ${platform} process identity for pid ${pid}: ${detail}`);
}

function runIdentityCommand(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    windowsHide: true,
    timeout: PROCESS_IDENTITY_PROBE_TIMEOUT_MS,
    maxBuffer: 64 * 1024
  });
  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

function linuxIdentity(pid, options) {
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const readlinkSync = options.readlinkSync ?? fs.readlinkSync;
  let stat;
  try {
    stat = String(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") {
      return null;
    }
    throw new Error(`Could not read /proc/${pid}/stat.`, { cause: error });
  }

  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1) {
    throw new Error(`Could not parse /proc/${pid}/stat: missing command terminator.`);
  }
  const fieldsFromThree = stat.slice(commandEnd + 1).trim().split(/\s+/);
  const startIdentity = fieldsFromThree[19];
  if (!startIdentity) {
    throw new Error(`Could not parse /proc/${pid}/stat field 22.`);
  }

  let executableIdentity;
  try {
    executableIdentity = String(readlinkSync(`/proc/${pid}/exe`));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") {
      return null;
    }
    throw new Error(`Could not read /proc/${pid}/exe.`, { cause: error });
  }
  if (!executableIdentity) {
    throw new Error(`Process ${pid} did not expose an executable identity.`);
  }

  return { pid, startIdentity, executableIdentity };
}

function macosIdentity(pid, options) {
  const runCommandImpl = options.runCommandImpl ?? runIdentityCommand;
  const args = ["-o", "lstart=", "-o", "command=", "-p", String(pid)];
  const result = runCommandImpl("ps", args, commandOptions(options));
  if (result.error) {
    throw commandFailure("macOS", pid, result);
  }
  const output = String(result.stdout ?? "").trim();
  if (result.status !== 0) {
    if (!output && !String(result.stderr ?? "").trim()) {
      return null;
    }
    throw commandFailure("macOS", pid, result);
  }
  if (!output) {
    return null;
  }

  const match = /^(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(output);
  if (!match) {
    throw new Error(`Could not parse macOS process identity for pid ${pid}.`);
  }
  return {
    pid,
    startIdentity: match[1],
    executableIdentity: match[2].trim()
  };
}

function windowsIdentity(pid, options) {
  const runCommandImpl = options.runCommandImpl ?? runIdentityCommand;
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
    "if ($null -ne $process) {",
    "  $process | Select-Object ProcessId, CreationDate, ExecutablePath, CommandLine | ConvertTo-Json -Compress",
    "}"
  ].join("\n");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  const result = runCommandImpl("powershell.exe", args, commandOptions(options));
  if (result.error || result.status !== 0) {
    throw commandFailure("Windows", pid, result);
  }
  const output = String(result.stdout ?? "").trim();
  if (!output) {
    return null;
  }

  let record;
  try {
    record = JSON.parse(output);
  } catch (error) {
    throw new Error(`Could not parse Windows process identity for pid ${pid}.`, { cause: error });
  }
  const recordPid = Number(record?.ProcessId);
  const startIdentity = String(record?.CreationDate ?? "").trim();
  const executablePath = String(record?.ExecutablePath ?? "").trim();
  const commandLine = String(record?.CommandLine ?? "").trim();
  const executableIdentity = [executablePath, commandLine].filter(Boolean).join("\n");
  if (recordPid !== pid || !startIdentity || !executableIdentity) {
    throw new Error(`Windows process identity for pid ${pid} was incomplete.`);
  }
  return { pid, startIdentity, executableIdentity };
}

export function captureProcessIdentity(pid, options = {}) {
  validatePid(pid);
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    return linuxIdentity(pid, options);
  }
  if (platform === "darwin") {
    return macosIdentity(pid, options);
  }
  if (platform === "win32") {
    return windowsIdentity(pid, options);
  }
  throw new Error(`Unsupported process identity platform: ${platform}`);
}

export function matchesProcessIdentity(expected, actual) {
  return Boolean(
    expected &&
    actual &&
    Number.isSafeInteger(expected.pid) &&
    expected.pid > 0 &&
    expected.pid === actual.pid &&
    typeof expected.startIdentity === "string" &&
    expected.startIdentity.length > 0 &&
    expected.startIdentity === actual.startIdentity &&
    typeof expected.executableIdentity === "string" &&
    expected.executableIdentity.length > 0 &&
    expected.executableIdentity === actual.executableIdentity
  );
}
