import fs from "node:fs";
import process from "node:process";

import {
  mutateJob,
  resolveJobLogFile,
} from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    const indexedJob = updateIndexedJob(workspaceRoot, jobId, (current) => {
      if (current.status === "cancelling" || current.status === "cancelled") {
        return null;
      }
      return patch;
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function updateIndexedJob(workspaceRoot, jobId, mutate) {
  return mutateJob(workspaceRoot, jobId, (storedJob, timestamp) => {
    const current = storedJob ?? { id: jobId, createdAt: timestamp };
    const patch = mutate(current, timestamp);
    if (patch == null) {
      return null;
    }
    return { ...current, ...patch };
  });
}

function cancellationTerminalPatch(current, timestamp) {
  return {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: current.completedAt ?? timestamp,
    cancelledAt: current.cancelledAt ?? timestamp,
    errorMessage: "Cancelled by user.",
    cancellationError: null
  };
}

export async function cancelTrackedJob(workspaceRoot, jobId, requestTermination) {
  if (typeof requestTermination !== "function") {
    throw new TypeError("Cancellation requires a termination request function.");
  }

  let alreadyCancelled = false;
  const cancellingJob = updateIndexedJob(workspaceRoot, jobId, (current, timestamp) => {
    if (current.status === "cancelled") {
      alreadyCancelled = true;
      return {};
    }
    if (!["queued", "running", "cancelling"].includes(current.status)) {
      throw new Error(`Job ${jobId} cannot be cancelled from status ${current.status ?? "unknown"}.`);
    }
    return {
      status: "cancelling",
      phase: "cancelling",
      cancelRequestedAt: current.cancelRequestedAt ?? timestamp
    };
  });

  if (alreadyCancelled) {
    return {
      job: cancellingJob,
      termination: null,
      repeated: true
    };
  }

  let termination;
  try {
    termination = await requestTermination(cancellingJob);
    if (termination?.terminal !== true) {
      throw Object.assign(
        new Error(termination?.detail ?? `Termination of job ${jobId} could not be confirmed.`),
        { code: "ERR_CANCELLATION_UNCONFIRMED" }
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failedJob = updateIndexedJob(workspaceRoot, jobId, (current, timestamp) => {
      if (current.status === "cancelled") {
        return null;
      }
      if (current.status !== "cancelling") {
        throw error;
      }
      return {
        status: "cancelling",
        phase: "cancelling",
        cancellationError: detail,
        lastCancelAttemptAt: timestamp
      };
    });
    throw error;
  }

  const cancelledJob = updateIndexedJob(workspaceRoot, jobId, (current, timestamp) => {
    if (current.status === "cancelled") {
      return null;
    }
    if (current.status !== "cancelling") {
      throw new Error(
        `Job ${jobId} reached ${current.status ?? "unknown"} before cancellation terminality was published.`
      );
    }
    return {
      ...cancellationTerminalPatch(current, timestamp),
      lastCancelAttemptAt: timestamp
    };
  });
  return {
    job: cancelledJob,
    termination,
    repeated: false
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = updateIndexedJob(job.workspaceRoot, job.id, (current, timestamp) => {
    if (current.status === "cancelling" || current.status === "cancelled") {
      return null;
    }
    return {
      ...job,
      status: "running",
      startedAt: timestamp,
      phase: "starting",
      pid: process.pid,
      logFile: options.logFile ?? job.logFile ?? null
    };
  });
  if (runningRecord.status === "cancelling" || runningRecord.status === "cancelled") {
    throw Object.assign(new Error(`Cancellation was requested for job ${job.id}.`), {
      code: "ERR_JOB_CANCELLING"
    });
  }

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const completedJob = updateIndexedJob(job.workspaceRoot, job.id, (current) => {
      if (current.status === "cancelling" || current.status === "cancelled") {
        return null;
      }
      return {
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        phase: completionStatus === "completed" ? "done" : "failed",
        pid: null,
        completedAt,
        result: execution.payload,
        rendered: execution.rendered
      };
    });
    if (completedJob.status !== "cancelled") {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    }
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    const failedJob = updateIndexedJob(job.workspaceRoot, job.id, (current) => {
      if (current.status === "cancelling" || current.status === "cancelled") {
        return null;
      }
      return {
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? current.logFile ?? null
      };
    });
    throw error;
  }
}
