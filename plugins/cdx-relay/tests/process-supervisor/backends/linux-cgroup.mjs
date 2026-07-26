import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import process from "node:process";

import { SupervisorInfrastructureError } from "../errors.mjs";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  validateKernelDrainedProof,
  validateReaperRequest
} from "../protocol.mjs";

const BACKEND = "linux-cgroup";
const ENDPOINT_ENV = "CDX_RELAY_LINUX_REAPER_ENDPOINT";
const CREDENTIAL_ENV = "CDX_RELAY_LINUX_REAPER_CREDENTIAL";
const PRIVATE_REAPER_ENV = Object.freeze([
  ENDPOINT_ENV,
  CREDENTIAL_ENV,
  "CDX_RELAY_LINUX_REAPER_REGISTRY"
]);
const REQUIRED_CHECKS = Object.freeze([
  "controllers",
  "disposableCgroupKill",
  "reaperOutsidePayloadPidNamespace",
  "payloadCgroupFilesReadOnly",
  "raceResistantHarnessWatch",
  "outerCgroupLifecycle"
]);

const fail = (code, message, cause) =>
  new SupervisorInfrastructureError(code, message, { cause });
const nonceHash = (nonce) =>
  createHash("sha256").update(nonce).digest("hex");
const safeReason = (value) =>
  String(value ?? "protected Linux reaper is unavailable")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 240);
const currentHarnessStartTime = () => {
  if (process.platform !== "linux") return `${process.pid}:${process.ppid}`;
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return stat.slice(close + 2).split(" ")[19];
  } catch {
    return "";
  }
};
const reviveBuffer = (value) =>
  value?.type === "Buffer" && Array.isArray(value.data)
    ? Buffer.from(value.data)
    : value;

function requestFrame(endpoint, credential, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint });
    let pending = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(fail(
      "PROTOCOL_HANDSHAKE_TIMEOUT",
      "Protected reaper request timed out."
    )), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(fail(
      "PROTOCOL_LOST",
      "Protected reaper channel is unavailable.",
      error
    )));
    socket.on("data", (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) {
        finish(fail("PROTOCOL_FRAME_TOO_LARGE", "Protected reaper response is too large."));
        return;
      }
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(pending.slice(0, newline));
        if (response?.error) {
          finish(fail(
            response.error.code ?? "REAPER_FAILURE",
            response.error.message ?? "Protected reaper request failed."
          ));
        } else {
          finish(null, response?.response);
        }
      } catch (error) {
        finish(fail("PROTOCOL_INVALID_MESSAGE", "Protected reaper returned invalid JSON.", error));
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ credential, request })}\n`);
    });
  });
}

function requestLaunchFrame(endpoint, credential, request, timeoutMs) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const socket = net.createConnection({ path: endpoint });
    let pending = "";
    let launchSettled = false;
    let rootSettled = false;
    let resolveRoot;
    let rejectRoot;
    const root = new Promise((resolve, reject) => {
      resolveRoot = resolve;
      rejectRoot = reject;
    });
    void root.catch(() => {});
    const failTransport = (error) => {
      if (!launchSettled) rejectLaunch(error);
      else if (!rootSettled) {
        rootSettled = true;
        rejectRoot(error);
      }
      socket.destroy();
    };
    const timer = setTimeout(() => failTransport(fail(
      "PROTOCOL_HANDSHAKE_TIMEOUT",
      "Protected reaper launch acknowledgement timed out."
    )), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => failTransport(fail(
      "PROTOCOL_LOST",
      "Protected reaper launch channel is unavailable.",
      error
    )));
    socket.on("data", (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) {
        failTransport(fail(
          "PROTOCOL_FRAME_TOO_LARGE",
          "Protected reaper launch frame is too large."
        ));
        return;
      }
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let frame;
        try {
          frame = JSON.parse(line);
        } catch (error) {
          failTransport(fail(
            "PROTOCOL_INVALID_MESSAGE",
            "Protected reaper returned invalid launch JSON.",
            error
          ));
          return;
        }
        if (!launchSettled) {
          if (frame?.error) {
            failTransport(fail(
              frame.error.code ?? "REAPER_FAILURE",
              frame.error.message ?? "Protected reaper launch failed."
            ));
            return;
          }
          if (!frame?.response || typeof frame.response !== "object") {
            failTransport(fail(
              "PROTOCOL_INVALID_MESSAGE",
              "Protected reaper launch acknowledgement is invalid."
            ));
            return;
          }
          clearTimeout(timer);
          launchSettled = true;
          resolveLaunch({ ...frame.response, root });
          continue;
        }
        if (frame?.event !== "root") {
          failTransport(fail(
            "PROTOCOL_INVALID_MESSAGE",
            "Protected reaper launch event is invalid."
          ));
          return;
        }
        rootSettled = true;
        if (frame.error) {
          rejectRoot(fail(
            frame.error.code ?? "PROTOCOL_LOST",
            frame.error.message ?? "Protected payload root failed."
          ));
        } else {
          resolveRoot(frame.root);
        }
        socket.destroy();
      }
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (!launchSettled) {
        rejectLaunch(fail(
          "PROTOCOL_LOST",
          "Protected reaper launch channel closed before acknowledgement."
        ));
      } else if (!rootSettled) {
        rootSettled = true;
        rejectRoot(fail(
          "PROTOCOL_LOST",
          "Protected reaper launch channel closed before root completion."
        ));
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ credential, request })}\n`);
    });
  });
}

export function createUnixLinuxReaperClient({
  endpoint = process.env[ENDPOINT_ENV],
  credential = process.env[CREDENTIAL_ENV],
  timeoutMs = 5000
} = {}) {
  if (!endpoint || !credential) return null;
  return {
    identity: null,
    request: (request) => request.operation === "launch"
      ? requestLaunchFrame(endpoint, credential, request, timeoutMs)
      : requestFrame(endpoint, credential, request, timeoutMs)
  };
}

export function createLinuxCgroupBackend({
  platform = process.platform,
  reaperClient = createUnixLinuxReaperClient(),
  randomId = randomUUID,
  harnessPid = process.pid,
  harnessStartTime = currentHarnessStartTime()
} = {}) {
  const leases = new Map();
  const probeIdentity = {
    epoch: `probe-${randomId()}`,
    runId: `probe-${randomId()}`,
    nonce: randomId()
  };
  let channelIdentity;
  let channelBootId;
  let recovered = false;
  let failure;

  const capabilities = Object.freeze({
    platform: "linux",
    backend: BACKEND,
    mode: "host-strict",
    containment: "kernel",
    cleanupProof: "kernel-drained",
    supportsDetachedDescendants: true
  });
  const latch = (error, code = "REAPER_FAILURE") => {
    const normalized = error instanceof SupervisorInfrastructureError
      ? error
      : fail(code, error?.message ?? String(error), error);
    failure ??= normalized;
    return normalized;
  };
  const assertHealthy = () => {
    if (failure) throw failure;
  };
  const send = async (operation, identity, payload = {}) => {
    assertHealthy();
    const request = validateReaperRequest({
      version: PROTOCOL_VERSION,
      operation,
      epoch: identity.epoch,
      runId: identity.runId,
      nonce: identity.nonce,
      payload
    });
    let response;
    try {
      response = await reaperClient.request(request);
    } catch (error) {
      throw latch(error, "PROTOCOL_LOST");
    }
    if (!response || response.version !== PROTOCOL_VERSION ||
        response.operation !== operation ||
        response.epoch !== identity.epoch ||
        response.runId !== identity.runId ||
        (operation !== "cleanup" && response.nonce !== identity.nonce)) {
      throw latch(fail(
        "PROTOCOL_IDENTITY_MISMATCH",
        "Protected reaper response does not match the active lease."
      ));
    }
    if (typeof response.reaperIdentity !== "string" ||
        response.reaperIdentity.length === 0 ||
        response.backend !== BACKEND ||
        typeof response.reaperBootId !== "string" ||
        response.reaperBootId.length === 0 ||
        (channelIdentity && response.reaperIdentity !== channelIdentity)) {
      throw latch(fail(
        "PROTOCOL_IDENTITY_MISMATCH",
        "Protected reaper identity changed during the authenticated channel."
      ));
    }
    if (channelBootId && response.reaperBootId !== channelBootId) {
      throw latch(fail(
        "PROTOCOL_IDENTITY_MISMATCH",
        "Protected reaper boot identity changed during the authenticated channel."
      ));
    }
    channelIdentity ??= response.reaperIdentity;
    channelBootId ??= response.reaperBootId;
    return response;
  };

  async function probe() {
    if (failure) throw failure;
    if (platform !== "linux") {
      return {
        available: false,
        code: "CAPABILITY_UNAVAILABLE",
        reason: "Protected cgroup supervision requires Linux."
      };
    }
    if (!reaperClient || typeof reaperClient.request !== "function") {
      return {
        available: false,
        code: "CAPABILITY_UNAVAILABLE",
        reason: "A protected reaper endpoint is required."
      };
    }
    let response;
    try {
      response = await send("probe", probeIdentity);
    } catch (error) {
      if (error?.code === "PROTOCOL_IDENTITY_MISMATCH") throw error;
      failure = undefined;
      return {
        available: false,
        code: "CAPABILITY_UNAVAILABLE",
        reason: safeReason(error?.message)
      };
    }
    const missing = REQUIRED_CHECKS.find((check) => response.checks?.[check] !== true);
    if (!response.available || missing) {
      return {
        available: false,
        code: "CAPABILITY_UNAVAILABLE",
        reason: safeReason(response.reason ??
          `Protected boundary prerequisite failed: ${missing ?? "unknown"}.`)
      };
    }
    try {
      const recovery = await send("recover", probeIdentity);
      if (recovery.recovered !== true) {
        throw fail("RECOVERY_REQUIRED", "Protected reaper recovery did not complete.");
      }
      recovered = true;
    } catch (error) {
      throw latch(error);
    }
    return { available: true, capabilities: { ...capabilities } };
  }

  async function cleanupLease(lease) {
    if (lease.cleanupPromise) return lease.cleanupPromise;
    lease.cleanupPromise = (async () => {
      const response = await send("cleanup", lease, {
        outerCgroup: lease.outerCgroup,
        proofToken: lease.proofToken
      });
      let proof;
      try {
        proof = validateKernelDrainedProof(response, {
          epoch: lease.epoch,
          runId: lease.runId,
          nonceHash: nonceHash(lease.nonce),
          proofTokenHash: nonceHash(lease.proofToken),
          outerCgroup: lease.outerCgroup,
          backend: BACKEND,
          reaperIdentity: channelIdentity,
          reaperBootId: channelBootId
        });
      } catch (error) {
        throw latch(error, "CLEANUP_UNPROVEN");
      }
      leases.delete(lease.runId);
      return {
        backend: BACKEND,
        level: proof.level,
        epoch: proof.epoch,
        runId: proof.runId,
        nonceHash: proof.nonceHash,
        proofTokenHash: proof.proofTokenHash,
        outerCgroup: proof.outerCgroup,
        populated: proof.populated,
        reaperBootId: proof.reaperBootId,
        reaperIdentity: proof.reaperIdentity,
        drainedAt: proof.drainedAt
      };
    })();
    return lease.cleanupPromise;
  }

  async function launch(spec) {
    assertHealthy();
    if (!recovered) {
      const available = await probe();
      if (!available.available) {
        throw latch(fail("CAPABILITY_UNAVAILABLE", available.reason));
      }
    }
    const identity = {
      epoch: spec.epoch,
      runId: spec.runId,
      nonce: spec.nonce
    };
    const proofToken = randomId();
    const env = { ...(spec.env ?? process.env) };
    for (const name of PRIVATE_REAPER_ENV) delete env[name];
    const response = await send("launch", identity, {
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd,
      env,
      input: spec.input,
      stdio: spec.stdio,
      maxBuffer: spec.maxBuffer,
      timeout: spec.timeout,
      harnessPid,
      harnessStartTime,
      proofToken
    });
    if (typeof response.outerCgroup !== "string" ||
        !response.outerCgroup ||
        typeof response.payloadCgroup !== "string" ||
        response.payloadCgroup !== `${response.outerCgroup}/payload` ||
        !response.root) {
      throw latch(fail(
        "PROTOCOL_INVALID_MESSAGE",
        "Protected reaper launch acknowledgement is incomplete."
      ));
    }
    const lease = {
      ...identity,
      outerCgroup: response.outerCgroup,
      payloadCgroup: response.payloadCgroup,
      proofToken,
      cleanupPromise: null
    };
    leases.set(lease.runId, lease);
    return {
      child: response.child ?? { pid: response.pid },
      pid: response.pid,
      root: Promise.resolve(response.root).then((root) => ({
        ...root,
        stdout: reviveBuffer(root.stdout),
        stderr: reviveBuffer(root.stderr)
      })),
      kill() {
        void cleanupLease(lease).catch(() => {});
        return { backend: BACKEND, stopped: true };
      },
      cleanup: () => cleanupLease(lease)
    };
  }

  async function cleanupAll() {
    await Promise.all([...leases.values()].map(cleanupLease));
    return {
      backend: BACKEND,
      level: "kernel-drained",
      populated: 0
    };
  }

  return {
    probe,
    launch,
    cleanup: cleanupAll,
    cleanupAll,
    assertHealthy,
    async shutdown() {
      await cleanupAll();
      if (reaperClient && recovered) {
        const response = await send("shutdown", probeIdentity);
        if (response.stopped !== true) {
          throw latch(fail("SHUTDOWN_UNPROVEN", "Protected reaper did not stop."));
        }
      }
      return { stopped: true };
    }
  };
}
