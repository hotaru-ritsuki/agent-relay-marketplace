import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { SupervisorInfrastructureError } from "../../errors.mjs";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  validateReaperRequest
} from "../../protocol.mjs";

const fail = (code, message, cause) =>
  new SupervisorInfrastructureError(code, message, { cause });
const nonceHash = (nonce) =>
  createHash("sha256").update(nonce).digest("hex");
const sameSecret = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const MODULE_PATH = fileURLToPath(import.meta.url);

export function createAtomicReaperRegistry(registryPath) {
  return {
    async list() {
      let names;
      try {
        names = await fs.readdir(registryPath);
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      const entries = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(registryPath, name);
        const stat = await fs.stat(file);
        if ((stat.mode & 0o077) !== 0) {
          throw fail("REGISTRY_INSECURE", "Protected registry entry permissions are unsafe.");
        }
        entries.push(JSON.parse(await fs.readFile(file, "utf8")));
      }
      return entries;
    },
    async write(entry) {
      await fs.mkdir(registryPath, { recursive: true, mode: 0o700 });
      const target = path.join(registryPath, `${entry.epoch}-${entry.runId}.json`);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(entry), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
    }
  };
}

export function createProtectedLinuxReaper({
  reaperIdentity,
  protectedRoot,
  checks,
  cgroups,
  registry,
  watchHarness,
  now = () => new Date()
}) {
  if (!reaperIdentity || !protectedRoot || !checks || !cgroups ||
      !registry || !watchHarness) {
    throw new TypeError("Protected reaper dependencies are required.");
  }
  const entries = new Map();
  const watches = new Map();
  let probed = false;
  let capable = false;
  let recovered = false;
  let stopped = false;
  let poisoned;

  const assertHealthy = () => {
    if (poisoned) throw poisoned;
    if (stopped) throw fail("REAPER_SHUTDOWN", "Protected reaper has shut down.");
  };
  const response = (request, payload) => ({
    version: PROTOCOL_VERSION,
    operation: request.operation,
    epoch: request.epoch,
    runId: request.runId,
    nonce: request.nonce,
    reaperIdentity,
    ...payload
  });
  const save = async (entry, state = entry.state) => {
    entry.state = state;
    await registry.write(entry);
    entries.set(entry.runId, entry);
  };
  const authenticate = (request) => {
    const entry = entries.get(request.runId);
    if (!entry) throw fail("UNAUTHENTICATED_RUN", "No authenticated registry lease matches the run.");
    if (entry.epoch !== request.epoch ||
        !sameSecret(entry.nonceHash, nonceHash(request.nonce))) {
      poisoned ??= fail(
        "PROTOCOL_IDENTITY_MISMATCH",
        "Reaper request identity does not match the authenticated registry lease."
      );
      throw poisoned;
    }
    return entry;
  };
  const drain = async (entry) => {
    if (entry.state === "drained") return entry;
    await save(entry, "draining");
    await cgroups.killOuter(entry);
    const maximumPolls = 500;
    let populated = 1;
    for (let attempt = 0; attempt < maximumPolls; attempt += 1) {
      const events = await cgroups.readOuterEvents(entry);
      populated = Number(events?.populated);
      if (populated === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (populated !== 0) {
      throw fail("CLEANUP_UNPROVEN", "Protected outer cgroup remains populated.");
    }
    watches.get(entry.runId)?.close?.();
    watches.delete(entry.runId);
    await cgroups.removeRun(entry);
    entry.drainedAt = now().toISOString();
    await save(entry, "drained");
    return entry;
  };

  async function recover(request) {
    const records = await registry.list();
    const drained = [];
    for (const record of records) {
      if (!record || typeof record !== "object" ||
          typeof record.epoch !== "string" ||
          typeof record.runId !== "string" ||
          typeof record.nonceHash !== "string" ||
          typeof record.outerCgroup !== "string" ||
          typeof record.payloadCgroup !== "string" ||
          !["created", "running", "draining", "drained"].includes(record.state)) {
        throw fail("REGISTRY_INVALID", "Protected registry contains an invalid entry.");
      }
      entries.set(record.runId, record);
      if (record.state !== "drained") {
        drained.push(record.runId);
        await drain(record);
      }
    }
    recovered = true;
    return response(request, {
      recovered: true,
      drained
    });
  }

  async function launch(request) {
    if (!probed || !capable) {
      throw fail("CAPABILITY_UNAVAILABLE", "Protected boundary prerequisites are unavailable.");
    }
    if (!recovered) throw fail("RECOVERY_REQUIRED", "Stale recovery must complete before launch.");
    if (entries.has(request.runId)) {
      throw fail("RUN_REPLAYED", "Run identifier already exists in the private registry.");
    }
    const payload = request.payload;
    if (typeof payload.command !== "string" || !payload.command ||
        !Array.isArray(payload.args) ||
        payload.args.some((argument) => typeof argument !== "string") ||
        !Number.isSafeInteger(payload.harnessPid) || payload.harnessPid <= 0 ||
        typeof payload.harnessStartTime !== "string" ||
        !payload.harnessStartTime) {
      throw fail("PROTOCOL_INVALID_MESSAGE", "Protected launch payload is invalid.");
    }
    const entry = {
      epoch: request.epoch,
      runId: request.runId,
      nonceHash: nonceHash(request.nonce),
      harnessPid: payload.harnessPid,
      harnessStartTime: payload.harnessStartTime,
      outerCgroup: `${protectedRoot}/${request.epoch}-${request.runId}`,
      payloadCgroup: `${protectedRoot}/${request.epoch}-${request.runId}/payload`,
      state: "created"
    };
    await cgroups.createRun(entry);
    await save(entry);
    let blocked;
    try {
      blocked = await cgroups.spawnBlockedShim(entry, payload);
      await cgroups.migrateBlockedShim(entry, blocked);
      const member = await cgroups.validatePayloadMembership(entry, blocked);
      const restricted = await cgroups.validateRestrictedNamespace(entry, blocked);
      if (member !== true || restricted !== true) {
        throw fail(
          "PAYLOAD_MIGRATION_REJECTED",
          "Blocked payload did not enter the authenticated restricted boundary."
        );
      }
      await save(entry, "running");
      const watch = await watchHarness(entry, () => drain(entry));
      watches.set(entry.runId, watch);
      await cgroups.releaseShim(entry, blocked);
    } catch (error) {
      try {
        await drain(entry);
      } catch (cleanupError) {
        poisoned ??= fail(
          "CLEANUP_UNPROVEN",
          "Rejected launch could not prove outer-cgroup drain.",
          cleanupError
        );
        throw poisoned;
      }
      throw error;
    }
    return response(request, {
      outerCgroup: entry.outerCgroup,
      payloadCgroup: entry.payloadCgroup,
      pid: blocked.pid,
      child: blocked.child,
      root: blocked.root
    });
  }

  return {
    async handleRequest(input) {
      assertHealthy();
      const request = validateReaperRequest(input);
      if (request.operation === "probe") {
        const result = await checks();
        probed = true;
        const required = [
          "controllers",
          "disposableCgroupKill",
          "reaperOutsidePayloadPidNamespace",
          "payloadCgroupFilesReadOnly",
          "raceResistantHarnessWatch",
          "outerCgroupLifecycle"
        ];
        const failed = required.find((name) => result?.[name] !== true);
        capable = !failed;
        return response(request, {
          available: !failed,
          checks: result,
          registry: [...entries.values()].map((entry) => ({
            epoch: entry.epoch,
            runId: entry.runId,
            state: entry.state
          })),
          ...(failed
            ? { reason: `Protected boundary prerequisite failed: ${failed}.` }
            : {})
        });
      }
      if (request.operation === "recover") return recover(request);
      if (request.operation === "launch") return launch(request);
      if (request.operation === "cleanup") {
        const entry = authenticate(request);
        if (request.payload.outerCgroup !== entry.outerCgroup) {
          poisoned ??= fail(
            "PROTOCOL_IDENTITY_MISMATCH",
            "Cleanup outer cgroup does not match the authenticated registry lease."
          );
          throw poisoned;
        }
        await drain(entry);
        return {
          version: PROTOCOL_VERSION,
          operation: "cleanup",
          level: "kernel-drained",
          epoch: entry.epoch,
          runId: entry.runId,
          nonceHash: entry.nonceHash,
          outerCgroup: entry.outerCgroup,
          populated: 0,
          reaperIdentity,
          drainedAt: entry.drainedAt
        };
      }
      if (request.operation === "shutdown") {
        for (const entry of entries.values()) {
          if (entry.state !== "drained") await drain(entry);
        }
        stopped = true;
        return response(request, { stopped: true });
      }
      throw fail("PROTOCOL_INVALID_MESSAGE", "Unsupported protected reaper operation.");
    },
    async handleControlLoss(runId) {
      assertHealthy();
      const entry = entries.get(runId);
      if (!entry) return false;
      await drain(entry);
      return true;
    },
    assertHealthy
  };
}

export async function serveProtectedLinuxReaper({
  reaper,
  socketPath,
  credential,
  socketUid,
  socketGid
}) {
  if (!socketPath || !credential) {
    throw new TypeError("Protected reaper socket and credential are required.");
  }
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await fs.rm(socketPath, { force: true });
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let pending = "";
    let request;
    let completed = false;
    socket.on("data", async (chunk) => {
      if (completed) return;
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) {
        completed = true;
        socket.destroy();
        return;
      }
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      completed = true;
      try {
        const frame = JSON.parse(pending.slice(0, newline));
        if (typeof frame?.credential !== "string" ||
            !sameSecret(frame.credential, credential)) {
          throw fail("REAPER_UNAUTHENTICATED", "Protected reaper credential is invalid.");
        }
        request = validateReaperRequest(frame.request);
        const result = await reaper.handleRequest(request);
        if (request.operation === "launch") {
          const root = result.root;
          const acknowledgement = { ...result };
          delete acknowledgement.root;
          delete acknowledgement.child;
          socket.write(`${JSON.stringify({ response: acknowledgement })}\n`);
          try {
            socket.end(`${JSON.stringify({
              event: "root",
              root: await root
            })}\n`);
          } catch (error) {
            socket.end(`${JSON.stringify({
              event: "root",
              error: {
                code: error?.code ?? "PROTOCOL_LOST",
                message: String(error?.message ?? error).slice(0, 240)
              }
            })}\n`);
          }
          return;
        }
        socket.end(`${JSON.stringify({ response: result })}\n`);
        if (request.operation === "shutdown") {
          setImmediate(() => server.close());
        }
      } catch (error) {
        socket.end(`${JSON.stringify({
          error: {
            code: error?.code ?? "REAPER_FAILURE",
            message: String(error?.message ?? error).slice(0, 240)
          }
        })}\n`);
      }
    });
    socket.once("close", () => {
      if (request?.operation === "launch" && !socket.writableEnded) {
        void reaper.handleControlLoss(request.runId).catch(() => {});
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
  if (Number.isInteger(socketUid) && Number.isInteger(socketGid)) {
    await fs.chown(socketPath, socketUid, socketGid);
  }
  return {
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
    server
  };
}

async function readPopulated(outerCgroup) {
  const events = await fs.readFile(path.join(outerCgroup, "cgroup.events"), "utf8");
  const match = /^populated\s+([01])$/m.exec(events);
  return { populated: match ? Number(match[1]) : NaN };
}

async function createCliService() {
  const protectedRoot = process.env.CDX_RELAY_LINUX_PROTECTED_ROOT;
  const registryPath = process.env.CDX_RELAY_LINUX_REAPER_REGISTRY;
  if (!protectedRoot || !registryPath) {
    throw new Error("Protected root and private registry paths are required.");
  }
  const checks = async () => {
    const result = {
      controllers: false,
      disposableCgroupKill: false,
      reaperOutsidePayloadPidNamespace:
        process.env.CDX_RELAY_LINUX_PID_NAMESPACE_VERIFIED === "1",
      payloadCgroupFilesReadOnly:
        process.env.CDX_RELAY_LINUX_CGROUP_RO_VERIFIED === "1",
      raceResistantHarnessWatch:
        process.env.CDX_RELAY_LINUX_PIDFD_VERIFIED === "1",
      outerCgroupLifecycle: false
    };
    try {
      await fs.access("/sys/fs/cgroup/cgroup.controllers");
      result.controllers = true;
      const probe = path.join(protectedRoot, `.probe-${process.pid}`);
      await fs.mkdir(probe);
      try {
        await fs.access(path.join(probe, "cgroup.kill"));
        result.disposableCgroupKill = true;
      } finally {
        await fs.rmdir(probe);
      }
      const outer = path.join(protectedRoot, `.outer-${process.pid}`);
      const payload = path.join(outer, "payload");
      await fs.mkdir(outer);
      await fs.mkdir(payload);
      await fs.rmdir(payload);
      await fs.rmdir(outer);
      result.outerCgroupLifecycle = true;
    } catch {
      // A failed kernel prerequisite is reported as unavailable, never inferred.
    }
    return result;
  };
  const cgroups = {
    async createRun(entry) {
      await fs.mkdir(entry.outerCgroup);
      await fs.mkdir(entry.payloadCgroup);
    },
    async spawnBlockedShim(entry, payload) {
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const payloadUid = process.env.CDX_RELAY_LINUX_PAYLOAD_UID;
      const payloadGid = process.env.CDX_RELAY_LINUX_PAYLOAD_GID;
      if (!/^\d+$/.test(payloadUid ?? "") || !/^\d+$/.test(payloadGid ?? "")) {
        throw fail("CAPABILITY_UNAVAILABLE", "Protected payload identity is missing.");
      }
      const script = [
        "mount -o remount,ro /sys/fs/cgroup",
        'exec setpriv --reuid="$1" --regid="$2" --clear-groups --no-new-privs "$3" "$4" --payload-shim "$5" "$6"'
      ].join("\n");
      const child = spawn("unshare", [
        "--mount",
        "--pid",
        "--fork",
        "--mount-proc",
        "--kill-child",
        "sh",
        "-ceu",
        script,
        "cdx-relay-shim",
        payloadUid,
        payloadGid,
        process.execPath,
        MODULE_PATH,
        encoded,
        String(process.pid)
      ], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      let resolveRoot;
      let rejectRoot;
      const root = new Promise((resolve, reject) => {
        resolveRoot = resolve;
        rejectRoot = reject;
      });
      void root.catch(() => {});
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(fail("PROTOCOL_HANDSHAKE_TIMEOUT", "Protected payload shim did not block."));
        }, 5000);
        child.once("error", reject);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          const newline = stdout.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timer);
          try {
            resolve(JSON.parse(stdout.slice(0, newline)));
            stdout = stdout.slice(newline + 1);
          } catch (error) {
            reject(fail("PROTOCOL_INVALID_MESSAGE", "Payload shim readiness is invalid.", error));
          }
        });
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try {
          const terminal = JSON.parse(stdout.slice(0, newline));
          if (terminal.type !== "root") throw new Error("not a root frame");
          resolveRoot({
            backend: "linux-cgroup",
            status: terminal.status,
            signal: terminal.signal,
            stdout: Buffer.from(terminal.stdout, "base64"),
            stderr: Buffer.from(terminal.stderr, "base64")
          });
        } catch (error) {
          rejectRoot(fail("PROTOCOL_INVALID_MESSAGE", "Payload shim terminal frame is invalid.", error));
        }
        stdout = "";
      });
      child.once("error", (error) => rejectRoot(fail(
        "PROTOCOL_LOST",
        "Protected payload shim failed.",
        error
      )));
      child.once("exit", (code, signal) => {
        if (code !== 0 && stdout.length === 0) {
          rejectRoot(fail(
            "PROTOCOL_LOST",
            `Protected payload shim exited before a root frame: ${stderr.slice(0, 160) || signal || code}.`
          ));
        }
      });
      return {
        pid: ready.hostPid,
        launcherPid: child.pid,
        child: { pid: ready.hostPid },
        root,
        ready
      };
    },
    async migrateBlockedShim(entry, blocked) {
      for (const pid of [blocked.launcherPid, blocked.pid]) {
        await fs.writeFile(path.join(entry.payloadCgroup, "cgroup.procs"), String(pid));
      }
    },
    async validatePayloadMembership(entry, blocked) {
      const members = new Set(
        (await fs.readFile(path.join(entry.payloadCgroup, "cgroup.procs"), "utf8"))
          .trim().split(/\s+/).filter(Boolean).map(Number)
      );
      return members.has(blocked.launcherPid) && members.has(blocked.pid);
    },
    async validateRestrictedNamespace(_entry, blocked) {
      const pidNamespace = await fs.readlink(`/proc/${blocked.pid}/ns/pid`);
      const reaperPidNamespace = await fs.readlink(`/proc/${process.pid}/ns/pid`);
      const mountNamespace = await fs.readlink(`/proc/${blocked.pid}/ns/mnt`);
      const reaperMountNamespace = await fs.readlink(`/proc/${process.pid}/ns/mnt`);
      return pidNamespace !== reaperPidNamespace &&
        mountNamespace !== reaperMountNamespace &&
        blocked.ready.reaperVisible === false &&
        blocked.ready.cgroupWritable === false;
    },
    async releaseShim(_entry, blocked) {
      process.kill(blocked.pid, "SIGCONT");
    },
    async killOuter(entry) {
      await fs.writeFile(path.join(entry.outerCgroup, "cgroup.kill"), "1");
    },
    readOuterEvents: (entry) => readPopulated(entry.outerCgroup),
    async removeRun(entry) {
      await fs.rmdir(entry.payloadCgroup).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await fs.rmdir(entry.outerCgroup).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  };
  const registry = createAtomicReaperRegistry(registryPath);
  return createProtectedLinuxReaper({
    reaperIdentity: `protected-reaper:${process.pid}`,
    protectedRoot,
    checks,
    cgroups,
    registry,
    async watchHarness(entry, onDeath) {
      const source = [
        "import os,select,sys",
        "pid=int(sys.argv[1]); expected=sys.argv[2]",
        "stat=open(f'/proc/{pid}/stat').read(); close=stat.rfind(')')",
        "actual=stat[close+2:].split()[19]",
        "assert actual == expected",
        "fd=os.pidfd_open(pid)",
        "print('READY', flush=True)",
        "poll=select.poll(); poll.register(fd); poll.poll()",
        "os.close(fd)"
      ].join("\n");
      const watcher = spawn("python3", [
        "-c",
        source,
        String(entry.harnessPid),
        entry.harnessStartTime
      ], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
      watcher.stdout.setEncoding("utf8");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          watcher.kill();
          reject(fail(
            "HARNESS_WATCH_UNAVAILABLE",
            "pidfd watcher did not acquire the harness handle."
          ));
        }, 5000);
        watcher.once("error", (error) => {
          clearTimeout(timer);
          reject(fail("HARNESS_WATCH_UNAVAILABLE", "pidfd watcher failed.", error));
        });
        watcher.once("exit", (code) => {
          clearTimeout(timer);
          reject(fail(
            "HARNESS_WATCH_UNAVAILABLE",
            `pidfd watcher exited before readiness (${code}).`
          ));
        });
        watcher.stdout.once("data", (chunk) => {
          if (!chunk.startsWith("READY")) return;
          clearTimeout(timer);
          resolve();
        });
      });
      let closed = false;
      watcher.once("exit", (code) => {
        if (!closed) void onDeath(code);
      });
      return {
        close() {
          closed = true;
          watcher.kill();
        }
      };
    }
  });
}

async function runPayloadShim() {
  const encoded = process.argv[process.argv.indexOf("--payload-shim") + 1];
  const reaperPid = Number(process.argv[process.argv.indexOf("--payload-shim") + 2]);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const status = await fs.readFile("/proc/self/status", "utf8");
  const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]
    ?.trim().split(/\s+/).map(Number) ?? [process.pid];
  let cgroupWritable = true;
  try {
    await fs.writeFile("/sys/fs/cgroup/cgroup.procs", String(process.pid));
  } catch {
    cgroupWritable = false;
  }
  let reaperVisible = true;
  try {
    await fs.access(`/proc/${reaperPid}`);
  } catch {
    reaperVisible = false;
  }
  process.stdout.write(`${JSON.stringify({
    type: "ready",
    hostPid: nspid[0],
    cgroupWritable,
    reaperVisible
  })}\n`);
  process.kill(process.pid, "SIGSTOP");
  const child = spawn(payload.command, payload.args ?? [], {
    cwd: payload.cwd,
    env: payload.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  if (payload.input !== undefined) {
    const input = payload.input?.type === "Buffer"
      ? Buffer.from(payload.input.data)
      : payload.input;
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }
  const terminal = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.stdout.write(`${JSON.stringify({
    type: "root",
    status: terminal.code,
    signal: terminal.signal,
    stdout: Buffer.concat(stdout).toString("base64"),
    stderr: Buffer.concat(stderr).toString("base64")
  })}\n`);
}

if (process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) &&
    process.argv.includes("--serve")) {
  const service = await createCliService();
  await serveProtectedLinuxReaper({
    reaper: service,
    socketPath: process.env.CDX_RELAY_LINUX_REAPER_ENDPOINT,
    credential: process.env.CDX_RELAY_LINUX_REAPER_CREDENTIAL,
    socketUid: Number(process.env.CDX_RELAY_LINUX_SOCKET_UID),
    socketGid: Number(process.env.CDX_RELAY_LINUX_SOCKET_GID)
  });
}

if (process.argv.includes("--payload-shim")) {
  await runPayloadShim();
}
