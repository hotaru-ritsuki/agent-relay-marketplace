import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import properLockfile from "proper-lockfile";

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
/** @type {Readonly<StateLockPolicy>} */
const DEFAULT_STATE_LOCK_POLICY = Object.freeze({
  stale: 30_000,
  update: 10_000,
  retryTimeoutMs: 35_000,
  retryDelayMs: 25
});
const STATE_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

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

function acquireStateLock(cwd) {
  ensureStateDir(cwd);
  const stateDir = resolveStateDir(cwd);
  const policy = { ...stateLockPolicy };
  const deadline = Date.now() + policy.retryTimeoutMs;

  for (;;) {
    try {
      return properLockfile.lockSync(stateDir, {
        realpath: false,
        retries: 0,
        stale: policy.stale,
        update: policy.update,
        onCompromised(error) {
          throw error;
        }
      });
    } catch (error) {
      if (error?.code !== "ELOCKED" || Date.now() >= deadline) {
        throw error;
      }
      const remaining = deadline - Date.now();
      Atomics.wait(
        STATE_LOCK_WAIT,
        0,
        0,
        Math.min(policy.retryDelayMs, Math.max(remaining, 0))
      );
    }
  }
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
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
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
      parsed.revision !== undefined &&
      (!Number.isInteger(parsed.revision) || parsed.revision < 0)
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
    const current = loadState(cwd);
    if (current.revision !== expectedRevision) {
      throw new StateConflictError(expectedRevision, current.revision);
    }
    return publishState(cwd, snapshot, current.revision + 1);
  });
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
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
    const state = loadState(cwd);
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
  for (const job of removedJobs ?? []) {
    if (!job || typeof job !== "object" || typeof job.id !== "string") {
      continue;
    }
    removeFileIfExists(resolveJobFile(cwd, job.id));
    if (typeof job.logFile === "string") {
      removeFileIfExists(job.logFile);
    }
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
