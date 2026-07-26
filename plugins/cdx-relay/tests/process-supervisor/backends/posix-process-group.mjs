import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { SupervisorInfrastructureError } from "../errors.mjs";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  validateHello,
  validateRoot
} from "../protocol.mjs";

const BACKEND = "posix-cooperative";
const TOKEN_ENV = "CDX_RELAY_SUPERVISOR_TOKEN";
const DEFAULT_SHIM = fileURLToPath(new URL("../launch-shim.mjs", import.meta.url));

function fail(code, message, cause) {
  return new SupervisorInfrastructureError(code, message, { cause });
}

export function decodeSupervisorToken(value) {
  let token;
  try {
    token = JSON.parse(Buffer.from(value ?? "", "base64url").toString("utf8"));
  } catch (error) {
    throw fail("PROTOCOL_INVALID_TOKEN", "Supervisor token is not valid base64url JSON.", error);
  }
  const keys = ["version", "epoch", "runId", "nonce", "endpoint"];
  if (!token || typeof token !== "object" || Array.isArray(token) ||
      token.version !== PROTOCOL_VERSION ||
      keys.slice(1).some((key) => typeof token[key] !== "string" || !token[key])) {
    throw fail("PROTOCOL_INVALID_TOKEN", "Supervisor token is missing required identity fields.");
  }
  return token;
}

export function encodeSupervisorToken(token) {
  decodeSupervisorToken(Buffer.from(JSON.stringify(token)).toString("base64url"));
  return Buffer.from(JSON.stringify(token)).toString("base64url");
}

function sameProcess(left, right) {
  return left && right &&
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.executable === right.executable;
}

async function inspectLinuxProcess(pid) {
  try {
    const [stat, executable] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readlink(`/proc/${pid}/exe`)
    ]);
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return {
      pid,
      processGroupId: Number(fields[2]),
      startTime: fields[19],
      executable
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }
}

async function inspectMacProcess(pid) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile("ps", ["-o", "pgid=", "-o", "lstart=", "-o", "comm=", "-p", String(pid)], {
      encoding: "utf8",
      shell: false
    }, (error, stdout) => {
      if (error?.code === 1) {
        resolve(null);
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      const value = stdout.trim();
      const match = value.match(
        /^(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/
      );
      resolve(match
        ? {
            pid,
            processGroupId: Number(match[1]),
            startTime: match[2],
            executable: match[3]
          }
        : null);
    });
  });
}

function endpointPath(endpoint) {
  if (!endpoint.startsWith("unix:")) {
    throw fail("PROTOCOL_INVALID_ENDPOINT", "POSIX registration endpoint must be a Unix socket.");
  }
  return endpoint.slice("unix:".length);
}

export async function createNetRegistrationChannel(handlers, {
  handshakeMs = 5000,
  socketPath = path.join(
    os.tmpdir(),
    `cdx-relay-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`
  )
} = {}) {
  let closing = false;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let pending = "";
    let registeredPid = null;
    const handshakeTimer = setTimeout(() => {
      socket.destroy(fail(
        "PROTOCOL_HANDSHAKE_TIMEOUT",
        "Registration hello deadline expired."
      ));
    }, handshakeMs);
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) {
        socket.destroy(fail(
          "PROTOCOL_FRAME_TOO_LARGE",
          `Registration frame exceeds ${MAX_FRAME_BYTES} bytes.`
        ));
        return;
      }
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const raw = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const message = JSON.parse(raw);
          if (message.type === "hello") {
            await handlers.hello(message);
            registeredPid = message.pid;
            clearTimeout(handshakeTimer);
            socket.write(`${JSON.stringify({ type: "release", version: 1 })}\n`);
          } else if (message.type === "root") {
            handlers.root(message);
          } else {
            throw fail("PROTOCOL_INVALID_MESSAGE", "Unknown registration message.");
          }
        } catch (error) {
          socket.destroy(error);
        }
      }
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      sockets.delete(socket);
      if (registeredPid !== null) {
        void handlers.closed(registeredPid).catch(handlers.lost);
      }
    });
    socket.on("error", (error) => {
      if (!closing) handlers.lost(error);
    });
  });
  server.on("error", (error) => {
    if (!closing) handlers.lost(error);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    endpoint: `unix:${socketPath}`,
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(socketPath, { force: true });
    }
  };
}

export function createPosixProcessGroupBackend({
  platform = process.platform,
  shimPath = DEFAULT_SHIM,
  spawn = nodeSpawn,
  createRegistrationChannel = createNetRegistrationChannel,
  inspectProcess = platform === "darwin" ? inspectMacProcess : inspectLinuxProcess,
  killGroup = (pid, signal) => process.kill(-pid, signal),
  killProcess = (pid, signal) => process.kill(pid, signal),
  waitForDrain: injectedWaitForDrain,
  discoverRecordedProcesses = async () => [],
  now = Date.now,
  graceMs = 1000,
  forceMs = 1000,
  handshakeMs = 5000,
  terminalFrameMs = 100
} = {}) {
  const leases = new Map();
  let protocolFailure = null;

  const capabilities = {
    platform,
    backend: BACKEND,
    mode: "cooperative",
    containment: "cooperative",
    cleanupProof: "registered-drained",
    supportsDetachedDescendants: false
  };

  const assertHealthy = () => {
    if (protocolFailure) throw protocolFailure;
  };

  const inspectOwned = async (expected) => {
    const actual = await inspectProcess(expected.pid);
    if (!sameProcess(actual, expected)) {
      throw fail(
        "PROCESS_IDENTITY_MISMATCH",
        `Process ${expected.pid} no longer matches its registered identity.`
      );
    }
    return actual;
  };

  async function signalGroup(lease, signal) {
    const root = await inspectProcess(lease.rootPid);
    if (!root) {
      if (lease.registry.size === 0) {
        lease.rootGone = true;
        return false;
      }
      for (const registered of lease.registry.values()) {
        const actual = await inspectOwned(registered);
        if (actual.processGroupId !== undefined &&
            actual.processGroupId !== lease.rootPid) {
          throw fail(
            "PROCESS_GROUP_UNPROVEN",
            "A registered descendant no longer belongs to the owned process group."
          );
        }
      }
    }
    if (root && !sameProcess(root, lease.rootIdentity)) {
      throw fail(
        "PROCESS_IDENTITY_MISMATCH",
        `Process ${lease.rootPid} no longer matches its root identity.`
      );
    }
    try {
      killGroup(lease.rootPid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      const root = await inspectProcess(lease.rootPid);
      if (sameProcess(root, lease.rootIdentity) || lease.registry.size > 0) {
        throw fail(
          "PROCESS_GROUP_UNPROVEN",
          "The process group disappeared before owned registration state drained.",
          error
        );
      }
      lease.rootGone = true;
      return false;
    }
    return true;
  }

  async function defaultWaitForDrain({ lease, deadline }) {
    while (now() < deadline) {
      const root = await inspectProcess(lease.rootPid);
      if (!sameProcess(root, lease.rootIdentity) && lease.registry.size === 0) {
        lease.rootGone = true;
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  async function verifyDrainedSnapshot(lease) {
    const root = await inspectProcess(lease.rootPid);
    if (root && !sameProcess(root, lease.rootIdentity)) {
      throw fail(
        "PROCESS_IDENTITY_MISMATCH",
        `Process ${lease.rootPid} no longer matches its root identity.`
      );
    }
    lease.rootGone = !root;
    for (const [pid, registered] of lease.registry) {
      const actual = await inspectProcess(pid);
      if (!actual) {
        lease.registry.delete(pid);
      } else if (!sameProcess(actual, registered)) {
        throw fail(
          "PROCESS_IDENTITY_MISMATCH",
          `Process ${pid} no longer matches its registered identity.`
        );
      }
    }
    return lease.rootGone && lease.registry.size === 0;
  }

  async function pollForVerifiedDrain(lease, deadline) {
    const maximumAttempts = Math.max(
      1,
      Math.min(1000, Math.ceil(forceMs / 10) + 1)
    );
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      if (await verifyDrainedSnapshot(lease)) return true;
      if (now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  async function cleanupLease(lease) {
    if (lease.cleanupPromise) return lease.cleanupPromise;
    lease.cleanupPromise = (async () => {
      const waitForDrain = injectedWaitForDrain ?? defaultWaitForDrain;
      const termSent = await signalGroup(lease, "SIGTERM");
      let drained = !termSent || await waitForDrain({
          lease,
          deadline: now() + graceMs,
          phase: "grace"
        });
      if (!drained) {
        const killSent = await signalGroup(lease, "SIGKILL");
        drained = !killSent || await waitForDrain({
            lease,
            deadline: now() + forceMs,
            phase: "force"
          });
      }
      if (!drained) {
        if (protocolFailure) throw protocolFailure;
        for (const [pid, registered] of lease.registry) {
          await inspectOwned(registered);
          try {
            killProcess(pid, "SIGKILL");
          } catch (error) {
            if (error?.code !== "ESRCH") throw error;
          }
        }
      }
      if (protocolFailure) throw protocolFailure;
      if (!await pollForVerifiedDrain(lease, now() + forceMs)) {
        throw fail(
          "CLEANUP_UNPROVEN",
          "Owned POSIX processes remain after bounded escalation."
        );
      }
      assertHealthy();
      await lease.channel.close();
      leases.delete(lease.runId);
      return {
        backend: BACKEND,
        level: "registered-drained",
        registered: lease.registry.size
      };
    })();
    return lease.cleanupPromise;
  }

  async function launch(spec) {
    assertHealthy();
    if (platform !== "linux" && platform !== "darwin") {
      throw fail("CAPABILITY_UNAVAILABLE", `POSIX backend is unavailable on ${platform}.`);
    }
    const registry = new Map();
    let resolveRoot;
    let rejectRoot;
    let rootSettled = false;
    let rootAuthenticated = false;
    let terminalFrameTimer;
    const root = new Promise((resolve, reject) => {
      resolveRoot = resolve;
      rejectRoot = reject;
    });
    void root.catch(() => {});
    const lease = {
      ...spec,
      registry,
      rootPid: null,
      rootIdentity: null,
      rootGone: false,
      cleanupPromise: null,
      channel: null
    };
    const expected = {
      epoch: spec.epoch,
      runId: spec.runId,
      nonce: spec.nonce,
      backend: BACKEND
    };
    lease.channel = await createRegistrationChannel({
      async hello(message) {
        validateHello(message, expected);
        if (!Number.isSafeInteger(message.pid) || message.pid <= 0 ||
            !Number.isSafeInteger(message.parentPid) || message.parentPid <= 0) {
          throw fail("PROTOCOL_INVALID_MESSAGE", "Registration requires pid and parentPid.");
        }
        const processIdentity = await inspectProcess(message.pid);
        if (!processIdentity || processIdentity.pid !== message.pid) {
          throw fail("PROCESS_IDENTITY_UNAVAILABLE", "Registered process identity is unavailable.");
        }
        if (processIdentity.processGroupId !== undefined &&
            processIdentity.processGroupId !== lease.rootPid) {
          throw fail(
            "PROCESS_GROUP_MISMATCH",
            "Registered process is outside the owned process group."
          );
        }
        registry.set(message.pid, processIdentity);
      },
      root(message) {
        try {
          validateRoot(message, expected);
        } catch (error) {
          rejectRoot(error);
          return;
        }
        rootAuthenticated = true;
        rootSettled = true;
        clearTimeout(terminalFrameTimer);
        resolveRoot({
          backend: BACKEND,
          status: message.status ?? null,
          signal: message.signal ?? null,
          stdout: message.stdout,
          stderr: message.stderr,
          error: message.error
        });
      },
      async closed(pid) {
        const registered = registry.get(pid);
        if (!registered) return;
        if (pid === lease.rootPid && rootAuthenticated) {
          registry.delete(pid);
          return;
        }
        const actual = await inspectProcess(pid);
        if (!actual) {
          registry.delete(pid);
          return;
        }
        protocolFailure ??= fail(
          "PROTOCOL_LOST",
          "Registration channel closed before validated process termination."
        );
      },
      lost(error) {
        protocolFailure ??= fail(
          "PROTOCOL_LOST",
          "The cooperative registration channel was lost.",
          error
        );
        rejectRoot(protocolFailure);
      }
    }, { handshakeMs });
    const token = encodeSupervisorToken({
      version: PROTOCOL_VERSION,
      epoch: spec.epoch,
      runId: spec.runId,
      nonce: spec.nonce,
      endpoint: lease.channel.endpoint
    });
    const target = Buffer.from(JSON.stringify({
      command: spec.command,
      args: spec.args ?? []
    })).toString("base64url");
    const child = spawn(process.execPath, [shimPath, target], {
      cwd: spec.cwd,
      env: { ...(spec.env ?? process.env), [TOKEN_ENV]: token },
      detached: true,
      shell: false,
      stdio: spec.stdio ?? ["pipe", "pipe", "pipe"],
      windowsHide: spec.windowsHide
    });
    lease.rootPid = child.pid;
    lease.rootIdentity = await inspectProcess(child.pid);
    if (!lease.rootIdentity) {
      await lease.channel.close();
      throw fail("PROCESS_IDENTITY_UNAVAILABLE", "Root process identity is unavailable.");
    }
    if (lease.rootIdentity.processGroupId !== undefined &&
        lease.rootIdentity.processGroupId !== child.pid) {
      await lease.channel.close();
      throw fail(
        "PROCESS_GROUP_MISMATCH",
        "Trusted launch shim did not become the process-group leader."
      );
    }
    leases.set(spec.runId, lease);
    child.once?.("error", (error) => {
      protocolFailure ??= fail(
        "PROTOCOL_LOST",
        "Trusted launch shim failed before authenticated root completion.",
        error
      );
      rejectRoot(protocolFailure);
    });
    child.once?.("exit", () => {
      if (rootSettled) return;
      terminalFrameTimer = setTimeout(() => {
        if (rootSettled) return;
        rootSettled = true;
        protocolFailure ??= fail(
          "PROTOCOL_LOST",
          "Trusted launch shim exited without an authenticated root frame."
        );
        rejectRoot(protocolFailure);
      }, terminalFrameMs);
      terminalFrameTimer.unref?.();
    });
    return {
      child,
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      root,
      kill(signal = "SIGTERM") {
        void cleanupLease(lease).catch((error) => {
          protocolFailure ??= error;
        });
        return { backend: BACKEND, stopped: true };
      },
      cleanup: () => cleanupLease(lease)
    };
  }

  async function cleanupAll() {
    assertHealthy();
    const recorded = await discoverRecordedProcesses();
    for (const record of recorded) {
      const lease = leases.get(record.runId);
      const registered = lease?.registry.get(record.pid);
      if (!lease ||
          lease.epoch !== record.epoch ||
          lease.nonce !== record.nonce ||
          record.backend !== BACKEND ||
          !registered) {
        throw fail(
          "UNREGISTERED_RECORDED_PROCESS",
          "Recorded process state has no matching cooperative registration."
        );
      }
    }
    await Promise.all([...leases.values()].map(cleanupLease));
    return { backend: BACKEND, level: "registered-drained", registered: 0 };
  }

  return {
    async probe() {
      return {
        available: platform === "linux" || platform === "darwin",
        capabilities: { ...capabilities }
      };
    },
    launch,
    cleanup: cleanupAll,
    cleanupAll,
    async shutdown() {
      await cleanupAll();
      return { stopped: true };
    }
  };
}
