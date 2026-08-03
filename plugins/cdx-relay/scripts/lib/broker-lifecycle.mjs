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
    markBrokerSessionFailed(cwd, session, detail);
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
    child.kill("SIGTERM");
  } catch {
    // Terminal proof below decides whether metadata can be removed.
  }
  const gracefulMs = Math.max(1, Math.floor(timeoutMs * 0.8));
  if (await waitForChildTerminal(child, gracefulMs)) return true;
  try {
    child.kill("SIGKILL");
  } catch {
    // Terminal proof below decides whether metadata can be removed.
  }
  return waitForChildTerminal(child, Math.max(1, timeoutMs - gracefulMs));
}

function removeBrokerArtifacts({ endpoint = null, pidFile = null, logFile = null, sessionDir = null }) {
  if (pidFile && fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  if (logFile && fs.existsSync(logFile)) fs.unlinkSync(logFile);
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

async function failSpawnedBroker(cwd, session, child, error, cleanupTimeoutMs) {
  markBrokerSessionFailed(cwd, session, error);
  const terminal = await terminateSpawnedBroker(child, cleanupTimeoutMs);
  if (terminal) {
    removeBrokerArtifacts(session);
    clearBrokerSessionIfNonce(cwd, session.nonce);
  }
  const suffix = terminal
    ? "The exact spawned child reached a terminal event."
    : "Exact-child termination could not be proved; diagnostic metadata was retained.";
  throw new Error(`${error.message} ${suffix}`, { cause: error });
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing?.state === "ready") {
    try {
      const status = await sendBrokerStatus(existing.endpoint, existing.nonce, options.statusTimeoutMs ?? 150);
      if (status.pid === existing.pid) return existing;
    } catch {
      // Teardown below classifies authentication, transport, and identity failures.
    }
  }

  if (existing) {
    const cleanup = await teardownBrokerSession({
      ...existing,
      killProcess: options.killProcess ?? terminateProcessTree,
      captureProcessIdentityImpl: options.captureProcessIdentityImpl ?? captureProcessIdentity,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? BROKER_SHUTDOWN_TIMEOUT_MS,
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
  const scriptPath = options.scriptPath ?? fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));
  const nonce = randomBytes(32).toString("hex");
  let session = {
    state: "starting",
    endpoint,
    pid: null,
    nonce,
    processIdentity: null,
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
      cleanupTimeoutMs
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
    if (!publishBrokerReady(cwd, session)) {
      throw new Error("Broker readiness was revoked before it could be published.");
    }
    return { ...session, state: "ready" };
  } catch (error) {
    return failSpawnedBroker(cwd, session, child, error, cleanupTimeoutMs);
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
  killProcess = terminateProcessTree,
  captureProcessIdentityImpl = captureProcessIdentity,
  shutdownTimeoutMs = BROKER_SHUTDOWN_TIMEOUT_MS,
  cleanupProofTimeoutMs = 1000
}) {
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

  if (!Number.isSafeInteger(pid) || pid <= 0 || !processIdentity) {
    return {
      removed: false,
      reason: "process-identity-unavailable",
      shutdown
    };
  }

  let currentIdentity;
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

  if (currentIdentity === null) {
    removeBrokerArtifacts({ endpoint, pidFile, logFile, sessionDir });
    return { removed: true, reason: "process-exited", shutdown };
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

  removeBrokerArtifacts({ endpoint, pidFile, logFile, sessionDir });
  return { removed: true, reason: "process-terminated", shutdown };
}
