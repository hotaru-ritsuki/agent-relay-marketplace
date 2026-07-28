import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
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
  socketPath,
  temporaryRoot = os.tmpdir()
} = {}) {
  let privateDirectory = null;
  if (!socketPath) {
    try {
      privateDirectory = await fs.mkdtemp(path.join(temporaryRoot, "cdx-relay-"));
      await fs.chmod(privateDirectory, 0o700);
      const metadata = await fs.stat(privateDirectory);
      if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
        throw fail(
          "CONTROL_CHANNEL_PERMISSIONS",
          "The POSIX control directory is not private."
        );
      }
      socketPath = path.join(privateDirectory, "control.sock");
    } catch (error) {
      if (privateDirectory) {
        await fs.rm(privateDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }
  let closing = false;
  const sockets = new Set();
  const socketsByPid = new Map();
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
            socketsByPid.set(message.pid, socket);
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
      if (registeredPid !== null && socketsByPid.get(registeredPid) === socket) {
        socketsByPid.delete(registeredPid);
      }
      if (registeredPid !== null) {
        void handlers.closed(registeredPid).catch(handlers.lost);
      }
    });
    socket.on("error", (error) => {
      if (!closing && registeredPid !== null) handlers.lost(error);
    });
  });
  server.on("error", (error) => {
    if (!closing) handlers.lost(error);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    closing = true;
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (privateDirectory) {
      await fs.rm(privateDirectory, { recursive: true, force: true });
    }
    throw error;
  }
  if (privateDirectory) {
    try {
      await fs.chmod(socketPath, 0o600);
      const metadata = await fs.stat(socketPath);
      if (!metadata.isSocket() || (metadata.mode & 0o077) !== 0) {
        throw fail(
          "CONTROL_CHANNEL_PERMISSIONS",
          "The POSIX control socket is not private."
        );
      }
    } catch (error) {
      closing = true;
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(privateDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    endpoint: `unix:${socketPath}`,
    async send(pid, message) {
      const deadline = Date.now() + handshakeMs;
      let socket = socketsByPid.get(pid);
      while ((!socket || socket.destroyed) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        socket = socketsByPid.get(pid);
      }
      if (!socket || socket.destroyed) {
        throw fail(
          "PROTOCOL_LOST",
          "The authenticated root control channel is unavailable."
        );
      }
      await new Promise((resolve, reject) => {
        socket.write(`${JSON.stringify(message)}\n`, (error) =>
          error ? reject(error) : resolve());
      });
    },
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      await fs.rm(socketPath, { force: true });
      if (privateDirectory) {
        await fs.rm(privateDirectory, { recursive: true, force: true });
      }
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

  const waitForBlockedShimExit = async (child) => {
    if (!child ||
        (child.exitCode !== null && child.exitCode !== undefined) ||
        (child.signalCode !== null && child.signalCode !== undefined)) {
      return;
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(fail(
          "CLEANUP_UNPROVEN",
          "The blocked launch shim did not exit after its private channel closed."
        ));
      }, handshakeMs);
      const settled = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once?.("exit", settled);
      child.once?.("error", settled);
    });
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
      try {
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
          for (const [pid, registered] of lease.registry) {
            await inspectOwned(registered);
            try {
              killProcess(pid, "SIGKILL");
            } catch (error) {
              if (error?.code !== "ESRCH") throw error;
            }
          }
        }
        if (!await pollForVerifiedDrain(lease, now() + forceMs)) {
          throw fail(
            "CLEANUP_UNPROVEN",
            "Owned POSIX processes remain after bounded escalation."
          );
        }
        if (protocolFailure) throw protocolFailure;
        assertHealthy();
        return {
          backend: BACKEND,
          level: "registered-drained",
          registered: lease.registry.size
        };
      } finally {
        await lease.channel.close();
        leases.delete(lease.runId);
      }
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
      channel: null,
      outputFailure: null,
      stdoutChunks: [],
      stderrChunks: [],
      capturedBytes: 0,
      stopRequested: false
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
        const completed = {
          backend: BACKEND,
          status: message.status ?? null,
          signal: message.signal ?? null,
          stdout: Buffer.concat(lease.stdoutChunks),
          stderr: Buffer.concat(lease.stderrChunks),
          error: message.error
        };
        if (lease.outputFailure) {
          rejectRoot(lease.outputFailure);
        } else {
          resolveRoot(completed);
        }
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
    leases.set(spec.runId, lease);
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
    let child;
    try {
      child = spawn(process.execPath, [shimPath, target], {
        cwd: spec.cwd,
        env: { ...(spec.env ?? process.env), [TOKEN_ENV]: token },
        detached: true,
        shell: false,
        stdio: spec.stdio ?? ["pipe", "pipe", "pipe"],
        windowsHide: spec.windowsHide
      });
      lease.rootPid = child.pid;
      child.once?.("error", (error) => {
        if (!lease.rootIdentity) {
          lease.provisionalError = error;
          return;
        }
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
      lease.rootIdentity = await inspectProcess(child.pid);
      if (lease.provisionalError) throw lease.provisionalError;
      if (!lease.rootIdentity) {
        throw fail("PROCESS_IDENTITY_UNAVAILABLE", "Root process identity is unavailable.");
      }
      if (lease.rootIdentity.processGroupId !== undefined &&
          lease.rootIdentity.processGroupId !== child.pid) {
        throw fail(
          "PROCESS_GROUP_MISMATCH",
          "Trusted launch shim did not become the process-group leader."
        );
      }
    } catch (error) {
      if (child && lease.rootIdentity?.processGroupId === child.pid) {
        let cleanupError;
        try {
          await cleanupLease(lease);
        } catch (caught) {
          cleanupError = caught;
        }
        leases.delete(spec.runId);
        if (cleanupError) throw cleanupError;
      } else {
        const blockedExit = child ? waitForBlockedShimExit(child) : null;
        await lease.channel.close();
        if (blockedExit) await blockedExit;
      }
      leases.delete(spec.runId);
      throw error;
    }
    const capture = (stream, chunks) => {
      if (!stream?.on) return null;
      const limit = spec.maxBuffer ?? MAX_FRAME_BYTES;
      const exposed = new PassThrough({
        highWaterMark: Math.max(1, Math.min(limit, 64 * 1024))
      });
      stream.on("data", (chunk) => {
        const value = Buffer.from(chunk);
        const remaining = Math.max(0, limit - lease.capturedBytes);
        if (remaining > 0) {
          const retained = value.subarray(0, remaining);
          chunks.push(retained);
          exposed.write(retained);
        }
        lease.capturedBytes += value.length;
        if (lease.capturedBytes > limit && !lease.outputFailure) {
          lease.outputFailure = fail(
            "OUTPUT_LIMIT_EXCEEDED",
            `POSIX output exceeded ${limit} bytes.`
          );
          rootSettled = true;
          rejectRoot(lease.outputFailure);
          if (rootAuthenticated) {
            void cleanupLease(lease).catch(() => {});
          } else {
            void requestStop("SIGTERM");
          }
        }
      });
      stream.once?.("end", () => exposed.end());
      stream.once?.("close", () => {
        if (!exposed.readableEnded) exposed.end();
      });
      return exposed;
    };
    const stdout = capture(child.stdout, lease.stdoutChunks);
    const stderr = capture(child.stderr, lease.stderrChunks);
    if (spec.input !== undefined) {
      child.stdin?.end(spec.input);
    }
    const requestStop = async (signal = "SIGTERM") => {
      if (lease.stopRequested) return;
      lease.stopRequested = true;
      try {
        await lease.channel.send(lease.rootPid, {
          type: "stop",
          version: PROTOCOL_VERSION,
          ...expected,
          signal
        });
      } catch (error) {
        protocolFailure ??= fail(
          "PROTOCOL_LOST",
          "Authenticated cancellation could not reach the launch shim.",
          error
        );
        if (!rootSettled) {
          rootSettled = true;
          rejectRoot(protocolFailure);
        }
      }
    };
    return {
      child,
      pid: child.pid,
      stdin: child.stdin,
      stdout,
      stderr,
      root,
      finalizeRoot(completed) {
        if (lease.outputFailure) throw lease.outputFailure;
        return {
          ...completed,
          stdout: Buffer.concat(lease.stdoutChunks),
          stderr: Buffer.concat(lease.stderrChunks)
        };
      },
      kill(signal = "SIGTERM") {
        void requestStop(signal);
        return { backend: BACKEND, stopped: true };
      },
      cleanup: () => cleanupLease(lease)
    };
  }

  async function cleanupAll() {
    let validationFailure;
    try {
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
    } catch (error) {
      validationFailure = error;
    }
    const cleanupResults = await Promise.allSettled(
      [...leases.values()].map(cleanupLease)
    );
    if (validationFailure) throw validationFailure;
    const rejected = cleanupResults.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    if (protocolFailure) {
      throw protocolFailure;
    }
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
