import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { captureProcessIdentity, matchesProcessIdentity } from "./process-identity.mjs";
import { spawnBackgroundProcess, terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
export const BROKER_AUTH_ERROR_CODE = -32002;
export const BROKER_SHUTDOWN_TIMEOUT_MS = 5000;
export const APP_SERVER_OWNERSHIP_FILE = "app-server-ownership.json";
const BROKER_STATE_FILE = "broker.json";
const MAX_CONTROL_RESPONSE_CHARS = 64 * 1024;

/** @typedef {Error & { code?: string }} BrokerControlError */

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

function brokerControlError(message, code, cause) {
  const error = /** @type {BrokerControlError} */ (
    new Error(message, cause ? { cause } : undefined)
  );
  error.code = code;
  return error;
}

async function sendBrokerControl(endpoint, method, nonce, timeoutMs) {
  if (typeof nonce !== "string" || nonce.length < 1) {
    throw brokerControlError(
      `Broker ${method} requires an authentication nonce.`,
      "ERR_BROKER_AUTH"
    );
  }
  const deadlineMs = timeoutMs ?? BROKER_SHUTDOWN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = connectToEndpoint(endpoint);
    const timer = setTimeout(() => {
      finish(brokerControlError(
        `Broker ${method} timed out after ${deadlineMs} ms.`,
        "ERR_BROKER_TIMEOUT"
      ));
    }, deadlineMs);
    timer.unref?.();

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method, params: { nonce } })}\n`, (error) => {
        if (error) {
          finish(brokerControlError(
            `Broker ${method} transport write failed: ${error.message}`,
            "ERR_BROKER_TRANSPORT",
            error
          ));
        }
      });
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_CONTROL_RESPONSE_CHARS) {
        finish(brokerControlError(
          `Broker ${method} returned an oversized authentication response.`,
          "ERR_BROKER_AUTH"
        ));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let message;
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(brokerControlError(
          `Broker ${method} returned an invalid authentication response.`,
          "ERR_BROKER_AUTH",
          error
        ));
        return;
      }
      if (message.id !== 1 || message.error) {
        const authFailure = message.error?.code === BROKER_AUTH_ERROR_CODE;
        finish(brokerControlError(
          authFailure
            ? `Broker ${method} authentication failed.`
            : `Broker ${method} handshake failed: ${message.error?.message ?? "unexpected response"}`,
          "ERR_BROKER_AUTH"
        ));
        return;
      }
      if (message.result?.nonce !== nonce) {
        finish(brokerControlError(
          `Broker ${method} authentication response did not match the stored nonce.`,
          "ERR_BROKER_AUTH"
        ));
        return;
      }
      finish(null, message.result);
    });
    socket.once("error", (error) => {
      finish(brokerControlError(
        `Broker ${method} transport failed: ${error.message}`,
        "ERR_BROKER_TRANSPORT",
        error
      ));
    });
    socket.once("close", () => {
      if (!settled) {
        finish(brokerControlError(
          `Broker ${method} transport closed before authentication completed.`,
          "ERR_BROKER_TRANSPORT"
        ));
      }
    });
  });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerStatus(endpoint, nonce, timeoutMs = BROKER_SHUTDOWN_TIMEOUT_MS) {
  const result = await sendBrokerControl(endpoint, "broker/status", nonce, timeoutMs);
  if (result?.state !== "ready" || !Number.isSafeInteger(result?.pid) || result.pid <= 0) {
    throw brokerControlError(
      "Broker status authentication response was incomplete.",
      "ERR_BROKER_AUTH"
    );
  }
  return result;
}

export async function sendBrokerShutdown(endpoint, nonce, timeoutMs = BROKER_SHUTDOWN_TIMEOUT_MS) {
  const result = await sendBrokerControl(endpoint, "broker/shutdown", nonce, timeoutMs);
  if (result?.stopped !== true) {
    throw brokerControlError(
      "Broker shutdown authentication response was incomplete.",
      "ERR_BROKER_AUTH"
    );
  }
  return result;
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, nonce = "", env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const childEnv = process.env.CDX_RELAY_SUPERVISOR_TOKEN &&
      env.CDX_RELAY_SUPERVISOR_TOKEN === undefined
    ? {
        ...env,
        CDX_RELAY_SUPERVISOR_TOKEN: process.env.CDX_RELAY_SUPERVISOR_TOKEN
      }
    : env;
  try {
    return spawnBackgroundProcess(process.execPath, [
      scriptPath,
      "serve",
      "--endpoint",
      endpoint,
      "--cwd",
      cwd,
      "--pid-file",
      pidFile,
      "--nonce",
      nonce
    ], {
      cwd,
      env: childEnv,
      stdio: ["ignore", logFd, logFd],
      shell: false,
      windowsHide: true
    });
  } finally {
    fs.closeSync(logFd);
  }
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
}

function clearBrokerSessionIfNonce(cwd, nonce) {
  const existing = loadBrokerSession(cwd);
  if (existing?.nonce === nonce) clearBrokerSession(cwd);
}

export function markBrokerSessionFailed(cwd, identity, failure) {
  const existing = loadBrokerSession(cwd);
  if (
    !existing ||
    existing.nonce !== identity?.nonce ||
    existing.endpoint !== identity?.endpoint ||
    existing.pid !== identity?.pid
  ) {
    return false;
  }
  if (existing.state === "failed") return true;
  saveBrokerSession(cwd, {
    ...existing,
    state: "failed",
    failure: failure instanceof Error ? failure.message : String(failure ?? "Broker exited unexpectedly.")
  });
  return true;
}

function resolveAppServerOwnershipFile(sessionDir) {
  return typeof sessionDir === "string" && sessionDir.length > 0
    ? path.join(sessionDir, APP_SERVER_OWNERSHIP_FILE)
    : null;
}

export function recordAppServerOwnership({
  sessionDir,
  endpoint,
  nonce,
  brokerPid = process.pid,
  childPid,
  processIdentity
}) {
  if (
    typeof sessionDir !== "string" ||
    typeof endpoint !== "string" ||
    typeof nonce !== "string" ||
    !Number.isSafeInteger(brokerPid) ||
    brokerPid <= 0 ||
    !Number.isSafeInteger(childPid) ||
    childPid <= 0 ||
    !matchesProcessIdentity({ ...processIdentity, pid: childPid }, processIdentity)
  ) {
    throw new Error("App-server ownership requires a complete broker binding and spawn-time process identity.");
  }
  const resolvedSessionDir = path.resolve(sessionDir);
  const ownershipFile = resolveAppServerOwnershipFile(resolvedSessionDir);
  const record = {
    version: 1,
    state: "spawned",
    broker: {
      nonce,
      pid: brokerPid,
      endpoint,
      sessionDir: resolvedSessionDir
    },
    child: {
      pid: childPid,
      processIdentity
    }
  };
  fs.writeFileSync(ownershipFile, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  return record;
}

function readBoundAppServerOwnership(session) {
  const ownershipFile = resolveAppServerOwnershipFile(session.sessionDir);
  if (!ownershipFile || !fs.existsSync(ownershipFile)) {
    return { valid: false, reason: "ownership-record-missing", ownershipFile };
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(ownershipFile, "utf8"));
  } catch (error) {
    return { valid: false, reason: "ownership-record-malformed", ownershipFile, error };
  }

  const childPid = record?.child?.pid;
  const childIdentity = record?.child?.processIdentity;
  const structurallyValid =
    record?.version === 1 &&
    record?.state === "spawned" &&
    typeof record?.broker?.nonce === "string" &&
    Number.isSafeInteger(record?.broker?.pid) &&
    typeof record?.broker?.endpoint === "string" &&
    typeof record?.broker?.sessionDir === "string" &&
    Number.isSafeInteger(childPid) &&
    childPid > 0 &&
    childIdentity?.pid === childPid &&
    typeof childIdentity?.startIdentity === "string" &&
    childIdentity.startIdentity.length > 0 &&
    typeof childIdentity?.executableIdentity === "string" &&
    childIdentity.executableIdentity.length > 0;
  if (!structurallyValid) {
    return { valid: false, reason: "ownership-record-malformed", ownershipFile };
  }

  let sessionDirMatches = false;
  try {
    sessionDirMatches = path.resolve(record.broker.sessionDir) === path.resolve(session.sessionDir);
  } catch {
    // The structural checks above are intentionally followed by binding checks.
  }
  if (
    record.broker.nonce !== session.nonce ||
    record.broker.pid !== session.pid ||
    record.broker.endpoint !== session.endpoint ||
    !sessionDirMatches
  ) {
    return { valid: false, reason: "ownership-record-unbound", ownershipFile, record };
  }
  return { valid: true, ownershipFile, record };
}

function publishBrokerReady(cwd, session) {
  const existing = loadBrokerSession(cwd);
  if (
    existing?.state !== "starting" ||
    existing.nonce !== session.nonce ||
    existing.endpoint !== session.endpoint ||
    existing.pid !== session.pid
  ) {
    return false;
  }
  saveBrokerSession(cwd, { ...session, state: "ready" });
  return true;
}

function observeBrokerChild(cwd, session, child) {
  const fail = (detail) => {
    try {
      markBrokerSessionFailed(cwd, session, detail);
    } catch {
      // A failed diagnostic write cannot turn child observation into an uncaught exception.
    }
  };
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    fail(new Error(
      `Broker child exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`
    ));
  });
}

async function waitForBrokerReady(endpoint, nonce, pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const status = await sendBrokerStatus(endpoint, nonce, Math.max(1, Math.min(150, remaining)));
      if (status.pid !== pid) {
        throw brokerControlError(
          `Broker status pid ${status.pid} did not match spawned pid ${pid}.`,
          "ERR_BROKER_AUTH"
        );
      }
      return status;
    } catch (error) {
      if (error?.code === "ERR_BROKER_AUTH") throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
  throw new Error(
    `Broker startup did not become ready within ${timeoutMs} ms.${lastError ? ` ${lastError.message}` : ""}`,
    lastError ? { cause: lastError } : undefined
  );
}

function childIsTerminal(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildTerminal(child, timeoutMs) {
  if (childIsTerminal(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onTerminal);
      child.off("close", onTerminal);
      resolve(value);
    };
    const onTerminal = () => finish(true);
    const timer = setTimeout(() => finish(childIsTerminal(child)), timeoutMs);
    child.once("exit", onTerminal);
    child.once("close", onTerminal);
  });
}

async function terminateSpawnedBroker(child, timeoutMs) {
  if (childIsTerminal(child)) return true;
  try {
    if (process.platform === "win32" && Number.isSafeInteger(child.pid)) {
      terminateProcessTree(child.pid);
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Terminal proof below decides whether metadata can be removed.
  }
  const gracefulMs = Math.max(1, Math.floor(timeoutMs * 0.8));
  if (await waitForChildTerminal(child, gracefulMs)) return true;
  try {
    if (process.platform === "win32" && Number.isSafeInteger(child.pid)) {
      terminateProcessTree(child.pid);
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // Terminal proof below decides whether metadata can be removed.
  }
  return waitForChildTerminal(child, Math.max(1, timeoutMs - gracefulMs));
}

async function waitForOwnedProcessExit(pid, expectedIdentity, timeoutMs, captureIdentity) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = captureIdentity(pid);
    if (current === null || !matchesProcessIdentity(expectedIdentity, current)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const current = captureIdentity(pid);
  return current === null || !matchesProcessIdentity(expectedIdentity, current);
}

function terminateOwnedAppServer(pid) {
  if (process.platform === "win32") terminateProcessTree(pid);
  else process.kill(pid, "SIGTERM");
}

async function proveOwnedAppServerTerminal(session, {
  timeoutMs,
  captureIdentity = captureProcessIdentity,
  terminateOwnedProcess = terminateOwnedAppServer,
  ownership = readBoundAppServerOwnership(session)
}) {
  if (!ownership.valid) {
    return { terminal: false, reason: ownership.reason, ownership };
  }

  const expectedIdentity = ownership.record.child.processIdentity;
  const pid = ownership.record.child.pid;
  let currentIdentity;
  try {
    currentIdentity = captureIdentity(pid);
  } catch (error) {
    return { terminal: false, reason: "owned-process-identity-unavailable", ownership, error };
  }
  if (currentIdentity === null || !matchesProcessIdentity(expectedIdentity, currentIdentity)) {
    return { terminal: true, reason: "owned-process-gone", ownership };
  }

  try {
    await terminateOwnedProcess(pid);
  } catch (error) {
    return { terminal: false, reason: "owned-process-termination-failed", ownership, error };
  }
  try {
    const terminal = await waitForOwnedProcessExit(
      pid,
      expectedIdentity,
      timeoutMs,
      captureIdentity
    );
    return {
      terminal,
      reason: terminal ? "owned-process-terminated" : "owned-process-termination-unproved",
      ownership
    };
  } catch (error) {
    return { terminal: false, reason: "owned-process-identity-unavailable", ownership, error };
  }
}

async function removeBrokerArtifactsAfterTerminalProof(session, options = {}) {
  const ownershipFile = resolveAppServerOwnershipFile(session.sessionDir);
  const ownershipRequired = session.appServerOwnershipRequired === true ||
    Boolean(ownershipFile && fs.existsSync(ownershipFile));
  if (ownershipRequired) {
    const proof = await proveOwnedAppServerTerminal(session, {
      timeoutMs: options.timeoutMs ?? 1000,
      captureIdentity: options.captureIdentity ?? captureProcessIdentity,
      terminateOwnedProcess: options.terminateOwnedProcess ?? terminateOwnedAppServer
    });
    if (!proof.terminal) {
      return {
        removed: false,
        reason: proof.reason,
        descendantProof: proof
      };
    }
  }
  removeBrokerArtifacts(session);
  return { removed: true };
}

function removeBrokerArtifacts({ endpoint = null, pidFile = null, logFile = null, sessionDir = null }) {
  if (pidFile && fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  if (logFile && fs.existsSync(logFile)) fs.unlinkSync(logFile);
  const appServerPidFile = sessionDir ? path.join(sessionDir, "app-server.pid") : null;
  if (appServerPidFile && fs.existsSync(appServerPidFile)) fs.unlinkSync(appServerPidFile);
  const appServerOwnershipFile = resolveAppServerOwnershipFile(sessionDir);
  if (appServerOwnershipFile && fs.existsSync(appServerOwnershipFile)) {
    fs.unlinkSync(appServerOwnershipFile);
  }
  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) fs.unlinkSync(target.path);
    } catch {
      // A malformed endpoint cannot identify an artifact to remove.
    }
  }
  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Diagnostic or fixture files can intentionally keep this directory non-empty.
    }
  }
}

async function failSpawnedBroker(cwd, session, child, error, cleanupTimeoutMs, options = {}) {
  const ownership = readBoundAppServerOwnership(session);
  markBrokerSessionFailed(cwd, session, error);
  const terminal = await terminateSpawnedBroker(child, cleanupTimeoutMs);
  const descendantProof = terminal
    ? await proveOwnedAppServerTerminal(session, {
        timeoutMs: cleanupTimeoutMs,
        captureIdentity: options.captureOwnedProcessIdentityImpl ?? captureProcessIdentity,
        terminateOwnedProcess: options.killOwnedProcess ?? terminateOwnedAppServer,
        ownership
      })
    : { terminal: false, reason: "broker-termination-unproved" };
  const descendantTerminal = descendantProof.terminal;
  if (terminal && descendantTerminal) {
    removeBrokerArtifacts(session);
    clearBrokerSessionIfNonce(cwd, session.nonce);
  }
  const suffix = terminal && descendantTerminal
    ? "The exact spawned broker and its recorded app-server descendant reached terminal state."
    : `Broker and app-server descendant terminality could not both be proved (${descendantProof.reason}); diagnostic metadata was retained.`;
  throw new Error(`${error.message} ${suffix}`, { cause: error });
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing?.state === "ready") {
    let readinessFailure = null;
    try {
      const status = await sendBrokerStatus(existing.endpoint, existing.nonce, options.statusTimeoutMs ?? 150);
      if (status.pid === existing.pid) return existing;
      readinessFailure = new Error(
        `Broker status pid ${status.pid} did not match recorded pid ${existing.pid}.`
      );
    } catch (error) {
      readinessFailure = error;
    }
    const publishFailed = options.markBrokerSessionFailedImpl ?? markBrokerSessionFailed;
    try {
      const published = publishFailed(
        cwd,
        existing,
        readinessFailure ?? new Error("Broker readiness could not be confirmed.")
      );
      if (!published) {
        throw new Error("The stored broker identity no longer matched the ready session.");
      }
    } catch (error) {
      throw new Error(
        "Broker failed state could not be durably published; teardown and replacement were refused.",
        { cause: error }
      );
    }
  }

  if (existing) {
    const cleanup = await teardownBrokerSession({
      ...existing,
      killProcess: options.killProcess ?? terminateProcessTree,
      killOwnedProcess: options.killOwnedProcess ?? terminateOwnedAppServer,
      captureProcessIdentityImpl: options.captureProcessIdentityImpl ?? captureProcessIdentity,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? BROKER_SHUTDOWN_TIMEOUT_MS,
      cooperativeExitTimeoutMs: options.cooperativeExitTimeoutMs,
      cleanupProofTimeoutMs: options.cleanupProofTimeoutMs
    });
    if (!cleanup.removed) {
      throw new Error(
        `Existing broker cleanup failed closed (${cleanup.reason}); diagnostic metadata was retained.`
      );
    }
    clearBrokerSessionIfNonce(cwd, existing.nonce);
  }

  const sessionDir = createBrokerSessionDir();
  const startupTimeoutMs = options.timeoutMs ?? 2000;
  const startupDeadline = Date.now() + startupTimeoutMs;
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const defaultScriptPath = fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));
  const scriptPath = options.scriptPath ?? defaultScriptPath;
  const nonce = randomBytes(32).toString("hex");
  let session = {
    state: "starting",
    endpoint,
    pid: null,
    nonce,
    processIdentity: null,
    appServerOwnershipRequired: options.appServerOwnershipRequired ?? (scriptPath === defaultScriptPath),
    pidFile,
    logFile,
    sessionDir
  };
  saveBrokerSession(cwd, session);

  let child;
  try {
    child = spawnBrokerProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      nonce,
      env: options.env ?? process.env
    });
  } catch (error) {
    saveBrokerSession(cwd, { ...session, state: "failed", failure: error.message });
    removeBrokerArtifacts(session);
    clearBrokerSessionIfNonce(cwd, nonce);
    throw error;
  }

  session = { ...session, pid: child.pid ?? null };
  saveBrokerSession(cwd, session);
  observeBrokerChild(cwd, session, child);
  await new Promise((resolve) => setImmediate(resolve));
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? BROKER_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(session.pid) || session.pid <= 0) {
    return failSpawnedBroker(
      cwd,
      session,
      child,
      new Error("Broker startup did not return a valid child pid."),
      cleanupTimeoutMs,
      {
        captureOwnedProcessIdentityImpl: options.captureOwnedProcessIdentityImpl,
        killOwnedProcess: options.killOwnedProcess
      }
    );
  }

  try {
    const captureIdentity = options.captureProcessIdentityImpl ?? captureProcessIdentity;
    const processIdentity = captureIdentity(session.pid);
    if (!processIdentity) {
      throw new Error(`Broker process ${session.pid} exited before its identity could be captured.`);
    }
    session = { ...session, processIdentity };
    saveBrokerSession(cwd, session);
    const remainingStartupMs = startupDeadline - Date.now();
    if (remainingStartupMs <= 0) {
      throw new Error(`Broker startup did not become ready within ${startupTimeoutMs} ms.`);
    }
    await waitForBrokerReady(endpoint, nonce, session.pid, remainingStartupMs);
    if (session.appServerOwnershipRequired && !readBoundAppServerOwnership(session).valid) {
      throw new Error("Broker readiness could not be published without a bound app-server ownership record.");
    }
    if (!publishBrokerReady(cwd, session)) {
      throw new Error("Broker readiness was revoked before it could be published.");
    }
    return { ...session, state: "ready" };
  } catch (error) {
    return failSpawnedBroker(cwd, session, child, error, cleanupTimeoutMs, {
      captureOwnedProcessIdentityImpl: options.captureOwnedProcessIdentityImpl,
      killOwnedProcess: options.killOwnedProcess
    });
  }
}

async function waitForRecordedProcessExit(pid, captureIdentity, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = captureIdentity(pid);
    if (current === null) return { exited: true, current: null };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { exited: false, current: captureIdentity(pid) };
}

export async function teardownBrokerSession({
  endpoint = null,
  pidFile = null,
  logFile = null,
  sessionDir = null,
  pid = null,
  nonce = null,
  processIdentity = null,
  appServerOwnershipRequired = false,
  killProcess = terminateProcessTree,
  killOwnedProcess = terminateOwnedAppServer,
  captureProcessIdentityImpl = captureProcessIdentity,
  shutdownTimeoutMs = BROKER_SHUTDOWN_TIMEOUT_MS,
  cooperativeExitTimeoutMs = 2000,
  cleanupProofTimeoutMs = 1000
}) {
  const artifactSession = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    nonce,
    appServerOwnershipRequired
  };
  const finalizeArtifacts = () => removeBrokerArtifactsAfterTerminalProof(artifactSession, {
    timeoutMs: cleanupProofTimeoutMs,
    captureIdentity: captureProcessIdentityImpl,
    terminateOwnedProcess: killOwnedProcess
  });
  let shutdown = null;
  if (endpoint) {
    try {
      shutdown = await sendBrokerShutdown(endpoint, nonce, shutdownTimeoutMs);
    } catch (error) {
      if (error?.code === "ERR_BROKER_AUTH") {
        return {
          removed: false,
          reason: "broker-authentication-failed",
          error
        };
      }
      shutdown = { error };
    }
  }

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return {
      removed: false,
      reason: "process-identity-unavailable",
      shutdown
    };
  }

  let currentIdentity;
  if (shutdown?.stopped === true) {
    let cooperativeProof;
    try {
      cooperativeProof = await waitForRecordedProcessExit(
        pid,
        captureProcessIdentityImpl,
        cooperativeExitTimeoutMs
      );
    } catch (error) {
      return {
        removed: false,
        reason: "process-identity-unavailable",
        shutdown,
        error
      };
    }
    if (cooperativeProof.exited) {
      const artifacts = await finalizeArtifacts();
      return artifacts.removed
        ? { removed: true, reason: "cooperative-shutdown", shutdown }
        : { ...artifacts, shutdown };
    }
    currentIdentity = cooperativeProof.current;
  }

  if (!processIdentity) {
    return {
      removed: false,
      reason: "process-identity-unavailable",
      shutdown
    };
  }

  if (currentIdentity === undefined) {
    try {
      currentIdentity = captureProcessIdentityImpl(pid);
    } catch (error) {
      return {
        removed: false,
        reason: "process-identity-unavailable",
        shutdown,
        error
      };
    }
  }

  if (currentIdentity === null) {
    const artifacts = await finalizeArtifacts();
    return artifacts.removed
      ? { removed: true, reason: "process-exited", shutdown }
      : { ...artifacts, shutdown };
  }
  if (!matchesProcessIdentity(processIdentity, currentIdentity)) {
    return {
      removed: false,
      reason: "process-identity-mismatch",
      shutdown,
      currentIdentity
    };
  }
  if (typeof killProcess !== "function") {
    return {
      removed: false,
      reason: "process-terminator-unavailable",
      shutdown
    };
  }

  try {
    await killProcess(pid);
  } catch (error) {
    return {
      removed: false,
      reason: "process-termination-failed",
      shutdown,
      error
    };
  }

  let proof;
  try {
    proof = await waitForRecordedProcessExit(pid, captureProcessIdentityImpl, cleanupProofTimeoutMs);
  } catch (error) {
    return {
      removed: false,
      reason: "process-identity-unavailable",
      shutdown,
      error
    };
  }
  if (!proof.exited) {
    return {
      removed: false,
      reason: matchesProcessIdentity(processIdentity, proof.current)
        ? "process-termination-unproved"
        : "process-identity-mismatch",
      shutdown,
      currentIdentity: proof.current
    };
  }

  const artifacts = await finalizeArtifacts();
  return artifacts.removed
    ? { removed: true, reason: "process-terminated", shutdown }
    : { ...artifacts, shutdown };
}
