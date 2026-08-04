import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort
} from "node:worker_threads";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
/**
 * @typedef {{
 *   stale: number,
 *   update: number,
 *   retryTimeoutMs: number,
 *   retryDelayMs: number
 * }} StateLockPolicy
 */
/**
 * @typedef {{
 *   worker: Worker,
 *   port: import("node:worker_threads").MessagePort,
 *   signal: Int32Array
 * }} StateLockOwner
 */
/** @type {Readonly<StateLockPolicy>} */
const DEFAULT_STATE_LOCK_POLICY = Object.freeze({
  stale: 30_000,
  update: 10_000,
  retryTimeoutMs: 35_000,
  retryDelayMs: 25
});
const STATE_LOCK_WORKER_STARTUP_GRACE_MS = 5_000;
const STATE_LOCK_WORKER_RELEASE_TIMEOUT_MS = 5_000;
const STATE_LOCK_WORKER_STATUS_COMPROMISED = 4;

/** @type {StateLockPolicy} */
let stateLockPolicy = { ...DEFAULT_STATE_LOCK_POLICY };

export class StateConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super(
      `ERR_STATE_CONFLICT: Expected state revision ${expectedRevision}, ` +
      `but the current revision is ${actualRevision}.`
    );
    this.name = "StateConflictError";
    this.code = "ERR_STATE_CONFLICT";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

class StateIndexCorruptionError extends Error {
  constructor(message, stateFile, options) {
    super(`ERR_STATE_INDEX_CORRUPT: ${message}`, options);
    this.code = "ERR_STATE_INDEX_CORRUPT";
    this.stateFile = stateFile;
  }
}

class JobArtifactPathError extends Error {
  constructor(message) {
    super(`ERR_JOB_ARTIFACT_PATH: ${message}`);
    this.code = "ERR_JOB_ARTIFACT_PATH";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    revision: 0,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

/**
 * @param {Partial<StateLockPolicy>} [overrides]
 * @returns {() => void}
 */
export function setStateLockPolicyForTests(overrides = {}) {
  const allowedKeys = new Set([
    "stale",
    "update",
    "retryTimeoutMs",
    "retryDelayMs"
  ]);
  for (const key of Object.keys(overrides)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`Unknown state lock policy option: ${key}`);
    }
  }
  const nextPolicy = { ...stateLockPolicy, ...overrides };
  for (const [key, value] of Object.entries(nextPolicy)) {
    if (!Number.isFinite(value) || value < 0 || (key === "retryDelayMs" && value === 0)) {
      throw new TypeError(`State lock policy ${key} must be a valid duration.`);
    }
  }
  if (nextPolicy.stale < 2_000) {
    throw new TypeError("State lock policy stale must be at least 2000 ms.");
  }
  if (nextPolicy.update < 1_000 || nextPolicy.update > nextPolicy.stale / 2) {
    throw new TypeError("State lock policy update must be between 1000 ms and stale / 2.");
  }

  const previousPolicy = stateLockPolicy;
  stateLockPolicy = nextPolicy;
  let restored = false;
  return () => {
    if (!restored) {
      stateLockPolicy = previousPolicy;
      restored = true;
    }
  };
}

/**
 * @param {{name?: string, message?: string, code?: string, stack?: string | null} | null} payload
 * @param {string} fallbackCode
 */
function deserializeLockWorkerError(payload, fallbackCode) {
  const error = Object.assign(new Error(payload?.message ?? fallbackCode), {
    code: payload?.code ?? fallbackCode
  });
  error.name = payload?.name ?? "Error";
  if (payload?.stack) {
    error.stack = payload.stack;
  }
  return error;
}

function lockWorkerProtocolError(message, code = "ERR_STATE_LOCK_WORKER_PROTOCOL") {
  return Object.assign(new Error(message), { code });
}

/**
 * @param {StateLockOwner} owner
 * @param {string} expectedType
 * @param {number} timeoutMs
 */
function waitForLockWorker(owner, expectedType, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const sequence = Atomics.load(owner.signal, 0);
    let packet;
    while ((packet = receiveMessageOnPort(owner.port))) {
      const message = packet.message;
      if (message?.type === expectedType) {
        return;
      }
      if (message?.type === "error" || message?.type === "compromised") {
        throw deserializeLockWorkerError(
          message.error,
          message.type === "compromised" ? "ECOMPROMISED" : "ERR_STATE_LOCK_WORKER"
        );
      }
      throw lockWorkerProtocolError(
        `Unexpected state lock worker message: ${String(message?.type ?? "unknown")}.`
      );
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const status = Atomics.load(owner.signal, 1);
      if (status === STATE_LOCK_WORKER_STATUS_COMPROMISED) {
        throw lockWorkerProtocolError(
          "State lock ownership was compromised.",
          "ECOMPROMISED"
        );
      }
      throw lockWorkerProtocolError(
        `State lock worker did not report ${expectedType} before the deadline.`,
        "ERR_STATE_LOCK_WORKER_EXIT"
      );
    }

    Atomics.wait(owner.signal, 0, sequence, Math.min(remaining, 50));
  }
}

/** @param {StateLockOwner} owner */
function stopLockWorker(owner) {
  owner.port.close();
  void owner.worker.terminate().catch(() => {
    // The worker may already have exited after posting its final response.
  });
}

function acquireStateLock(cwd) {
  ensureStateDir(cwd);
  const policy = { ...stateLockPolicy };
  const signalBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const signal = new Int32Array(signalBuffer);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL("./state-lock-worker.mjs", import.meta.url), {
    execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
    workerData: {
      port: port2,
      signalBuffer,
      stateDir: resolveStateDir(cwd),
      policy
    },
    transferList: [port2]
  });
  const owner = { worker, port: port1, signal };
  worker.unref();
  worker.on("error", () => {
    // The synchronous waiter observes worker failures through IPC or its deadline.
  });

  try {
    waitForLockWorker(
      owner,
      "acquired",
      policy.retryTimeoutMs + STATE_LOCK_WORKER_STARTUP_GRACE_MS
    );
  } catch (error) {
    stopLockWorker(owner);
    throw error;
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    try {
      port1.postMessage({ type: "release" });
      waitForLockWorker(owner, "released", STATE_LOCK_WORKER_RELEASE_TIMEOUT_MS);
    } finally {
      stopLockWorker(owner);
    }
  };
}

function withStateLock(cwd, operation) {
  const release = acquireStateLock(cwd);
  try {
    return operation();
  } finally {
    release();
  }
}

function normalizeLegacyRevision(revision) {
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function snapshotRevision(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("State snapshot must be an object.");
  }
  if (snapshot.revision === undefined) {
    return 0;
  }
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new TypeError("State snapshot revision must be a non-negative integer.");
  }
  return snapshot.revision;
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      revision: normalizeLegacyRevision(parsed.revision),
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function readStateIndexStrict(cwd) {
  const stateFile = resolveStateFile(cwd);
  let contents;
  try {
    contents = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw new StateIndexCorruptionError(
      `State index ${stateFile} contains malformed JSON.`,
      stateFile,
      { cause }
    );
  }
  const validJob = (job) =>
    job !== null &&
    typeof job === "object" &&
    !Array.isArray(job) &&
    typeof job.id === "string" &&
    job.id.length > 0 &&
    (
      job.request === undefined ||
      job.request === null ||
      (
        typeof job.request === "object" &&
        !Array.isArray(job.request) &&
        (
          job.request.jobId === undefined ||
          (
            typeof job.request.jobId === "string" &&
            job.request.jobId.length > 0
          )
        )
      )
    ) &&
    (
      job.pid === undefined ||
      job.pid === null ||
      (Number.isInteger(job.pid) && job.pid > 0)
    );
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (
      parsed.version !== undefined &&
      parsed.version !== STATE_VERSION
    ) ||
    (
      parsed.revision !== undefined &&
      (!Number.isInteger(parsed.revision) || parsed.revision < 0)
    ) ||
    (
      parsed.config !== undefined &&
      (
        parsed.config === null ||
        typeof parsed.config !== "object" ||
        Array.isArray(parsed.config)
      )
    ) ||
    !Array.isArray(parsed.jobs) ||
    !parsed.jobs.every(validJob)
  ) {
    throw new StateIndexCorruptionError(
      `State index ${stateFile} does not match the required schema.`,
      stateFile
    );
  }
  return {
    ...parsed,
    revision: normalizeLegacyRevision(parsed.revision)
  };
}

function loadStateForMutation(cwd) {
  const parsed = readStateIndexStrict(cwd);
  if (parsed === null) {
    return defaultState();
  }
  const defaults = defaultState();
  return {
    ...defaults,
    ...parsed,
    revision: normalizeLegacyRevision(parsed.revision),
    config: {
      ...defaults.config,
      ...(parsed.config ?? {})
    },
    jobs: parsed.jobs
  };
}

export function validateStateIndexPublicationCandidate(cwd, job) {
  if (
    !Number.isInteger(job?.pid) ||
    job.pid <= 0 ||
    !job.request ||
    typeof job.request !== "object" ||
    Array.isArray(job.request) ||
    typeof job.request.jobId !== "string" ||
    job.request.jobId.length === 0
  ) {
    const stateFile = resolveStateFile(cwd);
    throw new StateIndexCorruptionError(
      `State index ${stateFile} publication candidate does not include a valid pid and request job id.`,
      stateFile
    );
  }
  return job;
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function atomicWriteJson(filePath, payload) {
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  const directory = path.dirname(filePath);
  const temporaryFile = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor;
  try {
    let mode = 0o600;
    try {
      mode = fs.statSync(filePath).mode & 0o777;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    descriptor = fs.openSync(temporaryFile, "wx", mode);
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryFile, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the publication failure below.
      }
    }
    try {
      fs.unlinkSync(temporaryFile);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}

function publishState(cwd, state, revision) {
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    revision,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  atomicWriteJson(resolveStateFile(cwd), nextState);
  return nextState;
}

export function saveState(cwd, snapshot) {
  const expectedRevision = snapshotRevision(snapshot);
  return withStateLock(cwd, () => {
    const current = loadStateForMutation(cwd);
    if (current.revision !== expectedRevision) {
      throw new StateConflictError(expectedRevision, current.revision);
    }
    return publishState(cwd, snapshot, current.revision + 1);
  });
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadStateForMutation(cwd);
    const currentRevision = state.revision;
    mutate(state);
    return publishState(cwd, state, currentRevision + 1);
  });
}

export function removeJobs(cwd, ids) {
  const values = typeof ids === "string" ? [ids] : ids;
  if (!values || typeof values[Symbol.iterator] !== "function") {
    throw new TypeError("Job ids must be an iterable of strings.");
  }
  const explicitIds = new Set();
  for (const id of values) {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("Job ids must be non-empty strings.");
    }
    explicitIds.add(id);
  }

  return withStateLock(cwd, () => {
    const state = loadStateForMutation(cwd);
    const removedJobs = state.jobs.filter((job) => explicitIds.has(job.id));
    if (removedJobs.length === 0) {
      return [];
    }
    const retainedJobs = state.jobs.filter((job) => !explicitIds.has(job.id));
    publishState(
      cwd,
      { ...state, jobs: retainedJobs },
      state.revision + 1
    );
    return removedJobs;
  });
}

export function pruneJobArtifacts(cwd, removedJobs) {
  const jobs = removedJobs ?? [];
  if (typeof jobs[Symbol.iterator] !== "function") {
    throw new JobArtifactPathError("Removed jobs must be an iterable.");
  }

  const jobsDir = resolveJobsDir(cwd);
  const resolvedJobsDir = path.resolve(jobsDir);
  const targets = Array.from(jobs, (job) => {
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      throw new JobArtifactPathError("Removed job records must be objects.");
    }
    if (
      typeof job.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(job.id)
    ) {
      throw new JobArtifactPathError("Removed job ids must be safe filename segments.");
    }

    const jobFile = path.join(jobsDir, `${job.id}.json`);
    const expectedLogFile = path.join(jobsDir, `${job.id}.log`);
    if (
      path.dirname(path.resolve(jobFile)) !== resolvedJobsDir ||
      path.basename(jobFile) !== `${job.id}.json`
    ) {
      throw new JobArtifactPathError("Removed job JSON paths must be direct job-directory children.");
    }
    if (
      typeof job.logFile !== "string" ||
      job.logFile !== expectedLogFile ||
      path.dirname(path.resolve(expectedLogFile)) !== resolvedJobsDir ||
      path.basename(expectedLogFile) !== `${job.id}.log`
    ) {
      throw new JobArtifactPathError(
        "Removed job log paths must exactly match their direct job-directory child."
      );
    }
    return { jobFile, logFile: expectedLogFile };
  });

  for (const target of targets) {
    removeFileIfExists(target.jobFile);
    removeFileIfExists(target.logFile);
  }
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteJson(jobFile, payload);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
