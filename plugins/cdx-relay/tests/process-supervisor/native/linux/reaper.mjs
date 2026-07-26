import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
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
const BACKEND = "linux-cgroup";
const SAFE_IDENTITY = /^[A-Za-z0-9._-]{1,128}$/;
const nonceHash = (nonce) =>
  createHash("sha256").update(nonce).digest("hex");
const sameSecret = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const MODULE_PATH = fileURLToPath(import.meta.url);
// Leave room for base64 expansion plus the terminal-frame JSON envelope.
const PAYLOAD_OUTPUT_CAP = Math.floor((MAX_FRAME_BYTES - 4096) * 3 / 4);
const PAYLOAD_RUNTIME_CAP_MS = 10 * 60 * 1000;

const canonicalJson = (value) => JSON.stringify(Object.fromEntries(
  Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
));
const hasCompleteCgroupWriteDenials = (ready) =>
  ready?.cgroupWriteDenied?.procs === true &&
  ready.cgroupWriteDenied.threads === true &&
  ready.cgroupWriteDenied.subtreeControl === true;

export function deriveProtectedTupleKey(backend, epoch, runId) {
  if (![backend, epoch, runId].every((value) => typeof value === "string")) {
    throw new TypeError("Protected tuple components must be strings.");
  }
  return `lease-${createHash("sha256")
    .update(JSON.stringify([backend, epoch, runId]))
    .digest("hex")}`;
}

export async function loadOrCreateReaperAuthority(authorityPath, {
  expectedUid = process.getuid?.(),
  enforcePosixMetadata = process.platform !== "win32",
  hostBootId,
  requestedReaperBootId
} = {}) {
  const activeHostBootId = hostBootId ?? (
    process.platform === "linux"
      ? (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
      : `host-${process.platform}`
  );
  const desiredReaperBootId = requestedReaperBootId ?? randomUUID();
  if (!SAFE_IDENTITY.test(activeHostBootId) ||
      !SAFE_IDENTITY.test(desiredReaperBootId)) {
    throw fail(
      "REAPER_AUTHORITY_INSECURE",
      "Host and reaper boot identities must be safe nonempty identities."
    );
  }
  const directory = path.dirname(authorityPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
      (enforcePosixMetadata &&
        (directoryStat.uid !== expectedUid ||
         (directoryStat.mode & 0o777) !== 0o700))) {
    throw fail(
      "REAPER_AUTHORITY_INSECURE",
      "Reaper authority directory owner or mode is unsafe."
    );
  }
  try {
    await fs.writeFile(authorityPath, JSON.stringify({
      version: 2,
      hostBootId: activeHostBootId,
      reaperBootId: desiredReaperBootId,
      authenticationKey: randomBytes(32).toString("base64")
    }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    if (enforcePosixMetadata) await fs.chmod(authorityPath, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  let handle;
  try {
    handle = await fs.open(
      authorityPath,
      fsConstants.O_RDONLY |
        (enforcePosixMetadata ? fsConstants.O_NOFOLLOW : 0)
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096 ||
        (enforcePosixMetadata &&
          (stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600))) {
      throw fail(
        "REAPER_AUTHORITY_INSECURE",
        "Reaper authority file owner, mode, type, or size is unsafe."
      );
    }
    const stored = JSON.parse(await handle.readFile("utf8"));
    const authenticationKey = Buffer.from(
      stored.authenticationKey ?? "",
      "base64"
    );
    if (stored.version !== 2 ||
        !SAFE_IDENTITY.test(stored.hostBootId ?? "") ||
        !SAFE_IDENTITY.test(stored.reaperBootId ?? "") ||
        authenticationKey.length !== 32) {
      throw fail(
        "REAPER_AUTHORITY_INSECURE",
        "Reaper authority content is invalid."
      );
    }
    if (stored.hostBootId !== activeHostBootId) {
      throw fail(
        "REAPER_HOST_BOOT_CHANGED",
        "Durable reaper authority belongs to a different Linux host boot."
      );
    }
    if (requestedReaperBootId &&
        stored.reaperBootId !== requestedReaperBootId) {
      throw fail(
        "REAPER_BOOT_ID_MISMATCH",
        "Configured reaper boot identity does not match durable authority."
      );
    }
    return {
      reaperBootId: stored.reaperBootId,
      authenticationKey
    };
  } finally {
    await handle?.close();
  }
}

export function createAtomicReaperRegistry(registryPath, {
  authenticationKey,
  reaperBootId,
  expectedUid = process.getuid?.(),
  enforcePosixMetadata = process.platform !== "win32"
} = {}) {
  if (!Buffer.isBuffer(authenticationKey) || authenticationKey.length < 32 ||
      !SAFE_IDENTITY.test(reaperBootId ?? "")) {
    throw new TypeError("Registry authentication key and reaper boot identity are required.");
  }
  const authenticate = (entry) => createHmac("sha256", authenticationKey)
    .update(canonicalJson(entry))
    .digest("hex");
  const assertDirectory = async () => {
    await fs.mkdir(registryPath, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(registryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (enforcePosixMetadata &&
          (stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o700))) {
      throw fail(
        "REGISTRY_INSECURE",
        "Protected registry directory owner or mode is unsafe."
      );
    }
  };
  return {
    async list() {
      await assertDirectory();
      const names = await fs.readdir(registryPath);
      const entries = [];
      for (const name of names) {
        if (name === ".authority.json") continue;
        if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) {
          throw fail("REGISTRY_INSECURE", "Protected registry filename is unsafe.");
        }
        const file = path.join(registryPath, name);
        let handle;
        try {
          handle = await fs.open(
            file,
            fsConstants.O_RDONLY |
              (enforcePosixMetadata ? fsConstants.O_NOFOLLOW : 0)
          );
        } catch (error) {
          throw fail(
            "REGISTRY_INSECURE",
            "Protected registry entry cannot be opened without following links.",
            error
          );
        }
        try {
          const stat = await handle.stat();
          if (!stat.isFile() ||
              (enforcePosixMetadata &&
                (stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600)) ||
              stat.size > MAX_FRAME_BYTES) {
            throw fail(
              "REGISTRY_INSECURE",
              "Protected registry entry owner, mode, type, or size is unsafe."
            );
          }
          const stored = JSON.parse(await handle.readFile("utf8"));
          const { authentication, ...entry } = stored;
          const expectedName =
            `${deriveProtectedTupleKey(
              entry.backend,
              entry.epoch,
              entry.runId
            )}.json`;
          if (name !== expectedName ||
              entry.reaperBootId !== reaperBootId ||
              typeof authentication !== "string" ||
              !sameSecret(authentication, authenticate(entry))) {
            throw fail(
              "REGISTRY_AUTHENTICATION_FAILED",
              "Protected registry record authentication failed."
            );
          }
          entries.push(entry);
        } finally {
          await handle.close();
        }
      }
      return entries;
    },
    async write(entry) {
      await assertDirectory();
      if (!SAFE_IDENTITY.test(entry?.epoch ?? "") ||
          !SAFE_IDENTITY.test(entry?.runId ?? "") ||
          entry.reaperBootId !== reaperBootId) {
        throw fail(
          "REGISTRY_AUTHENTICATION_FAILED",
          "Protected registry write identity is invalid."
        );
      }
      const target = path.join(
        registryPath,
        `${deriveProtectedTupleKey(entry.backend, entry.epoch, entry.runId)}.json`
      );
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      const stored = { ...entry, authentication: authenticate(entry) };
      await fs.writeFile(temporary, JSON.stringify(stored), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      if (enforcePosixMetadata) await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, target);
      if (enforcePosixMetadata) await fs.chmod(target, 0o600);
    }
  };
}

export function createProtectedLinuxReaper({
  reaperIdentity,
  reaperBootId,
  protectedRoot,
  checks,
  cgroups,
  registry,
  watchHarness,
  now = () => new Date()
}) {
  if (!reaperIdentity || !reaperBootId || !protectedRoot || !checks || !cgroups ||
      !registry || !watchHarness) {
    throw new TypeError("Protected reaper dependencies are required.");
  }
  const entries = new Map();
  const watches = new Map();
  const drains = new Map();
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
    backend: BACKEND,
    reaperIdentity,
    reaperBootId,
    ...payload
  });
  const canonicalPaths = (epoch, runId) => {
    const outerCgroup = path.posix.join(
      protectedRoot.replaceAll("\\", "/"),
      deriveProtectedTupleKey(BACKEND, epoch, runId)
    );
    return {
      outerCgroup,
      payloadCgroup: path.posix.join(outerCgroup, "payload")
    };
  };
  const validateRegistryRecord = (record) => {
    if (!record || typeof record !== "object" ||
        record.backend !== BACKEND ||
        record.reaperBootId !== reaperBootId ||
        !SAFE_IDENTITY.test(record.epoch ?? "") ||
        !SAFE_IDENTITY.test(record.runId ?? "") ||
        !/^[a-f0-9]{64}$/.test(record.nonceHash ?? "") ||
        !/^[a-f0-9]{64}$/.test(record.proofTokenHash ?? "") ||
        typeof record.proofConsumed !== "boolean" ||
        !Number.isSafeInteger(record.harnessPid) ||
        record.harnessPid <= 0 ||
        typeof record.harnessStartTime !== "string" ||
        record.harnessStartTime.length === 0 ||
        !["created", "running", "draining", "drained"].includes(record.state)) {
      throw fail(
        "REGISTRY_AUTHENTICATION_FAILED",
        "Protected registry record identity is invalid."
      );
    }
    const expected = canonicalPaths(record.epoch, record.runId);
    if (record.outerCgroup !== expected.outerCgroup ||
        record.payloadCgroup !== expected.payloadCgroup) {
      throw fail(
        "REGISTRY_AUTHENTICATION_FAILED",
        "Protected registry record paths are not canonical."
      );
    }
    return record;
  };
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
  const drain = (entry) => {
    const key = deriveProtectedTupleKey(
      entry.backend,
      entry.epoch,
      entry.runId
    );
    if (drains.has(key)) return drains.get(key);
    const operation = (async () => {
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
      entry.lastPopulated = 0;
      const watch = watches.get(entry.runId);
      watches.delete(entry.runId);
      await watch?.close?.();
      await cgroups.removeRun(entry);
      entry.drainedAt = now().toISOString();
      await save(entry, "drained");
      return entry;
    })().catch((error) => {
      poisoned ??= error instanceof SupervisorInfrastructureError
        ? error
        : fail(
            "CLEANUP_FAILED",
            String(error?.message ?? error).slice(0, 240),
            error
          );
      throw poisoned;
    });
    drains.set(key, operation);
    return operation;
  };

  async function recover(request) {
    const records = await registry.list();
    const drained = [];
    for (const record of records) {
      validateRegistryRecord(record);
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
        !payload.harnessStartTime ||
        typeof payload.proofToken !== "string" ||
        payload.proofToken.length < 16) {
      throw fail("PROTOCOL_INVALID_MESSAGE", "Protected launch payload is invalid.");
    }
    const paths = canonicalPaths(request.epoch, request.runId);
    const entry = {
      backend: BACKEND,
      reaperBootId,
      epoch: request.epoch,
      runId: request.runId,
      nonceHash: nonceHash(request.nonce),
      proofTokenHash: nonceHash(payload.proofToken),
      proofConsumed: false,
      harnessPid: payload.harnessPid,
      harnessStartTime: payload.harnessStartTime,
      ...paths,
      state: "created"
    };
    await cgroups.createRun(entry);
    await save(entry);
    let blocked;
    try {
      const { proofToken: _proofToken, ...targetPayload } = payload;
      blocked = await cgroups.spawnBlockedShim(entry, targetPayload);
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
      const watch = await watchHarness(entry, () => {
        void drain(entry).catch((error) => {
          poisoned ??= error instanceof SupervisorInfrastructureError
            ? error
            : fail(
                "CLEANUP_FAILED",
                String(error?.message ?? error).slice(0, 240),
                error
              );
        });
      });
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
    const root = Promise.resolve(blocked.root).then(async (terminal) => {
      if (terminal?.boundaryBreach) await drain(entry);
      return terminal;
    });
    return response(request, {
      outerCgroup: entry.outerCgroup,
      payloadCgroup: entry.payloadCgroup,
      pid: blocked.pid,
      child: blocked.child,
      root
    });
  }

  return {
    async handleRequest(input) {
      assertHealthy();
      const request = validateReaperRequest(input, {
        backend: BACKEND,
        reaperBootId
      });
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
        const registryState = await Promise.all(
          [...entries.values()].map(async (entry) => {
            let populated = entry.lastPopulated;
            let pids = [];
            if (entry.state !== "drained") {
              populated = Number((await cgroups.readOuterEvents(entry)).populated);
              pids = await cgroups.readPayloadPids?.(entry) ?? [];
            }
            return {
              epoch: entry.epoch,
              runId: entry.runId,
              state: entry.state,
              populated,
              pids
            };
          })
        );
        return response(request, {
          available: !failed,
          checks: result,
          registry: registryState,
          ...(failed
            ? { reason: `Protected boundary prerequisite failed: ${failed}.` }
            : {})
        });
      }
      if (request.operation === "recover") return recover(request);
      if (request.operation === "launch") return launch(request);
      if (request.operation === "cleanup") {
        const entry = authenticate(request);
        if (entry.proofConsumed) {
          throw fail("PROOF_REPLAYED", "Cleanup proof token was already consumed.");
        }
        if (typeof request.payload.proofToken !== "string" ||
            !sameSecret(
              entry.proofTokenHash,
              nonceHash(request.payload.proofToken)
            )) {
          poisoned ??= fail(
            "PROOF_TOKEN_MISMATCH",
            "Cleanup proof token does not match the authenticated registry lease."
          );
          throw poisoned;
        }
        if (request.payload.outerCgroup !== entry.outerCgroup) {
          poisoned ??= fail(
            "PROTOCOL_IDENTITY_MISMATCH",
            "Cleanup outer cgroup does not match the authenticated registry lease."
          );
          throw poisoned;
        }
        entry.proofConsumed = true;
        await save(entry, entry.state);
        await drain(entry);
        return {
          version: PROTOCOL_VERSION,
          operation: "cleanup",
          backend: BACKEND,
          level: "kernel-drained",
          epoch: entry.epoch,
          runId: entry.runId,
          nonceHash: entry.nonceHash,
          proofTokenHash: entry.proofTokenHash,
          reaperBootId,
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

export async function reportControlLoss(reaper, runId, reportError) {
  try {
    await reaper.handleControlLoss(runId);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export async function serveProtectedLinuxReaper({
  reaper,
  socketPath,
  credential,
  socketUid,
  socketGid,
  reportError = (error) => console.error(
    `Protected reaper control-loss cleanup failed: ${error?.message ?? error}`
  )
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
        void reportControlLoss(reaper, request.runId, reportError);
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

export async function runBoundedPayload({
  payload,
  spawnProcess = spawn,
  onBoundaryBreach = () => {}
}) {
  const requestedBuffer = Number.isSafeInteger(payload.maxBuffer)
    ? payload.maxBuffer
    : PAYLOAD_OUTPUT_CAP;
  const maxBuffer = Math.max(0, Math.min(PAYLOAD_OUTPUT_CAP, requestedBuffer));
  const requestedTimeout = Number.isSafeInteger(payload.timeout) && payload.timeout > 0
    ? payload.timeout
    : PAYLOAD_RUNTIME_CAP_MS;
  const timeout = Math.min(PAYLOAD_RUNTIME_CAP_MS, requestedTimeout);
  const child = spawnProcess(payload.command, payload.args ?? [], {
    cwd: payload.cwd,
    env: payload.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  let captured = 0;
  let settled = false;
  let timer;

  return new Promise((resolve) => {
    const finish = (root) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(root);
    };
    const breach = (reason, code, message) => {
      if (settled) return;
      onBoundaryBreach(reason);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill("SIGKILL");
      finish({
        status: null,
        signal: "SIGKILL",
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        error: { code, message },
        boundaryBreach: reason
      });
    };
    const capture = (chunks, chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      const remaining = Math.max(0, maxBuffer - captured);
      if (remaining > 0) {
        chunks.push(bytes.subarray(0, remaining));
        captured += Math.min(bytes.length, remaining);
      }
      if (bytes.length > remaining) {
        breach(
          "output-limit",
          "ENOBUFS",
          `Protected payload output exceeded ${maxBuffer} bytes.`
        );
      }
    };
    child.stdout?.on("data", (chunk) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => finish({
      status: null,
      signal: null,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      error: {
        code: error?.code ?? "PAYLOAD_ERROR",
        message: String(error?.message ?? error).slice(0, 240)
      }
    }));
    child.once("exit", (code, signal) => finish({
      status: code,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr)
    }));
    if (payload.input !== undefined) {
      const input = payload.input?.type === "Buffer"
        ? Buffer.from(payload.input.data)
        : payload.input;
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
    timer = setTimeout(() => breach(
      "runtime-limit",
      "ETIMEDOUT",
      `Protected payload exceeded ${timeout} milliseconds.`
    ), timeout);
    timer.unref?.();
  });
}

export async function createPidfdHarnessWatcher({
  entry,
  onDeath,
  spawnWatcher = spawn,
  readyLimit = 128,
  readyTimeoutMs = 5000
}) {
  const source = [
    "import ctypes,os,select,signal,sys",
    "assert ctypes.CDLL(None).prctl(1, signal.SIGKILL) == 0",
    "pid=int(sys.argv[1]); expected=sys.argv[2]",
    "fd=os.pidfd_open(pid)",
    "poll=select.poll(); poll.register(fd)",
    "assert not poll.poll(0)",
    "stat=open(f'/proc/{pid}/stat').read(); close=stat.rfind(')')",
    "actual=stat[close+2:].split()[19]",
    "assert actual == expected",
    "assert not poll.poll(0)",
    "print('READY', flush=True)",
    "poll.poll()",
    "os.close(fd)"
  ].join("\n");
  const watcher = spawnWatcher("python3", [
    "-c",
    source,
    String(entry.harnessPid),
    entry.harnessStartTime
  ], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
  watcher.stdout.setEncoding?.("utf8");
  let ready = false;
  let closed = false;
  let pending = "";
  const handle = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      closed = true;
      watcher.kill();
      reject(fail(
        "HARNESS_WATCH_UNAVAILABLE",
        "pidfd watcher did not acquire the harness handle."
      ));
    }, readyTimeoutMs);
    const failReady = (message, cause) => {
      if (ready) return;
      clearTimeout(timer);
      closed = true;
      watcher.kill();
      reject(fail("HARNESS_WATCH_UNAVAILABLE", message, cause));
    };
    watcher.once("error", (error) => {
      if (!ready) failReady("pidfd watcher failed.", error);
      else if (!closed) onDeath(error);
    });
    watcher.once("exit", (code) => {
      if (!ready) {
        failReady(`pidfd watcher exited before readiness (${code}).`);
      } else if (!closed) {
        onDeath(code);
      }
    });
    watcher.stdout.on("data", (chunk) => {
      if (ready || closed) return;
      pending += chunk;
      if (Buffer.byteLength(pending) > readyLimit) {
        failReady("pidfd watcher readiness frame exceeded its bound.");
        return;
      }
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      if (pending.slice(0, newline) !== "READY" ||
          pending.slice(newline + 1).length !== 0) {
        failReady("pidfd watcher readiness frame is invalid.");
        return;
      }
      clearTimeout(timer);
      ready = true;
      resolve({
        close() {
          closed = true;
          watcher.kill();
        }
      });
    });
  });
  return handle;
}

export async function performProtectedBoundaryProbe({
  protectedRoot,
  cgroups,
  watchHarness,
  accessControllers = () => fs.access("/sys/fs/cgroup/cgroup.controllers"),
  readStartTime
}) {
  const checks = {
    controllers: false,
    disposableCgroupKill: false,
    reaperOutsidePayloadPidNamespace: false,
    payloadCgroupFilesReadOnly: false,
    raceResistantHarnessWatch: false,
    outerCgroupLifecycle: false
  };
  const epoch = `probe-${process.pid}`;
  const runId = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const outerCgroup = path.posix.join(
    protectedRoot,
    deriveProtectedTupleKey(BACKEND, epoch, runId)
  );
  const entry = {
    backend: BACKEND,
    reaperBootId: "probe",
    epoch,
    runId,
    nonceHash: nonceHash("probe"),
    proofTokenHash: nonceHash("probe-proof-token"),
    proofConsumed: false,
    harnessPid: process.pid,
    harnessStartTime: "probe",
    outerCgroup,
    payloadCgroup: path.posix.join(outerCgroup, "payload"),
    state: "created"
  };
  let blocked;
  let watch;
  try {
    await accessControllers();
    checks.controllers = true;
    await cgroups.createRun(entry);
    checks.disposableCgroupKill = await cgroups.hasCgroupKill(entry) === true;
    if (!checks.disposableCgroupKill) return checks;
    blocked = await cgroups.spawnBlockedShim(entry, {
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: {},
      maxBuffer: 1024,
      timeout: 5000
    });
    void blocked.root?.catch?.(() => {});
    await cgroups.migrateBlockedShim(entry, blocked);
    const member = await cgroups.validatePayloadMembership(entry, blocked);
    const restricted = await cgroups.validateRestrictedNamespace(entry, blocked);
    checks.reaperOutsidePayloadPidNamespace =
      restricted === true && blocked.ready?.reaperVisible === false;
    checks.payloadCgroupFilesReadOnly =
      restricted === true && hasCompleteCgroupWriteDenials(blocked.ready);
    if (member !== true ||
        !checks.reaperOutsidePayloadPidNamespace ||
        !checks.payloadCgroupFilesReadOnly) {
      return checks;
    }
    const startTime = await readStartTime(blocked.pid);
    watch = await watchHarness({
      harnessPid: blocked.pid,
      harnessStartTime: startTime
    }, () => {});
    checks.raceResistantHarnessWatch = true;
    await cgroups.releaseShim(entry, blocked);
    await cgroups.killOuter(entry);
    let populated = 1;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      populated = (await cgroups.readOuterEvents(entry)).populated;
      if (populated === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (populated !== 0) return checks;
    await watch.close();
    watch = undefined;
    await cgroups.removeRun(entry);
    checks.outerCgroupLifecycle = true;
    return checks;
  } catch {
    return checks;
  } finally {
    await Promise.resolve(watch?.close?.()).catch(() => {});
    if (!checks.outerCgroupLifecycle) {
      if (blocked) await cgroups.killOuter(entry).catch(() => {});
      await cgroups.removeRun(entry).catch(() => {});
    }
  }
}

async function readPopulated(outerCgroup) {
  const events = await fs.readFile(path.join(outerCgroup, "cgroup.events"), "utf8");
  const match = /^populated\s+([01])$/m.exec(events);
  return { populated: match ? Number(match[1]) : NaN };
}

async function readLinuxStartTime(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

async function createCliService() {
  const protectedRoot = process.env.CDX_RELAY_LINUX_PROTECTED_ROOT;
  const registryPath = process.env.CDX_RELAY_LINUX_REAPER_REGISTRY;
  if (!protectedRoot || !registryPath) {
    throw new Error("Protected root and private registry paths are required.");
  }
  const watchHarness = (entry, onDeath) =>
    createPidfdHarnessWatcher({ entry, onDeath });
  let cgroups;
  const checks = () => performProtectedBoundaryProbe({
    protectedRoot,
    cgroups,
    watchHarness,
    readStartTime: readLinuxStartTime
  });
  cgroups = {
    async createRun(entry) {
      await fs.mkdir(entry.outerCgroup);
      await fs.mkdir(entry.payloadCgroup);
    },
    async hasCgroupKill(entry) {
      try {
        await fs.access(path.join(entry.outerCgroup, "cgroup.kill"));
        return true;
      } catch {
        return false;
      }
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
      let pending = "";
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        if (Buffer.byteLength(stderr) < 4096) stderr += chunk;
      });
      let resolveReady;
      let rejectReady;
      let readySettled = false;
      let resolveRoot;
      let rejectRoot;
      let rootSettled = false;
      const readyPromise = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const root = new Promise((resolve, reject) => {
        resolveRoot = resolve;
        rejectRoot = reject;
      });
      void root.catch(() => {});
      const timer = setTimeout(() => {
        if (readySettled) return;
        readySettled = true;
        child.kill("SIGKILL");
        rejectReady(fail(
          "PROTOCOL_HANDSHAKE_TIMEOUT",
          "Protected payload shim did not block."
        ));
      }, 5000);
      const failFrames = (error) => {
        clearTimeout(timer);
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
        }
        if (!rootSettled) {
          rootSettled = true;
          rejectRoot(error);
        }
        child.kill("SIGKILL");
      };
      child.stdout.on("data", (chunk) => {
        pending += chunk;
        if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) {
          failFrames(fail(
            "PROTOCOL_FRAME_TOO_LARGE",
            "Payload shim frame exceeded its bound."
          ));
          return;
        }
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const frame = JSON.parse(line);
            if (!readySettled) {
              if (frame.type !== "ready" ||
                  !Number.isSafeInteger(frame.hostPid) ||
                  !hasCompleteCgroupWriteDenials(frame) ||
                  typeof frame.reaperVisible !== "boolean") {
                throw new Error("not a complete ready frame");
              }
              clearTimeout(timer);
              readySettled = true;
              resolveReady(frame);
              continue;
            }
            if (rootSettled || frame.type !== "root") {
              throw new Error("not one terminal root frame");
            }
            rootSettled = true;
            resolveRoot({
              backend: "linux-cgroup",
              status: frame.status,
              signal: frame.signal,
              stdout: Buffer.from(frame.stdout, "base64"),
              stderr: Buffer.from(frame.stderr, "base64"),
              error: frame.error,
              boundaryBreach: frame.boundaryBreach
            });
          } catch (error) {
            failFrames(fail(
              "PROTOCOL_INVALID_MESSAGE",
              "Payload shim frame is invalid.",
              error
            ));
            return;
          }
        }
      });
      child.once("error", (error) => failFrames(fail(
          "PROTOCOL_LOST",
          "Protected payload shim failed.",
          error
        )));
      child.once("exit", (code, signal) => {
        if (!rootSettled) {
          failFrames(fail(
            "PROTOCOL_LOST",
            `Protected payload shim exited before a root frame: ${stderr.slice(0, 160) || signal || code}.`
          ));
        }
      });
      const ready = await readyPromise;
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
    async readPayloadPids(entry) {
      return (await fs.readFile(path.join(entry.payloadCgroup, "cgroup.procs"), "utf8"))
        .trim().split(/\s+/).filter(Boolean).map(Number);
    },
    async validateRestrictedNamespace(_entry, blocked) {
      const pidNamespace = await fs.readlink(`/proc/${blocked.pid}/ns/pid`);
      const reaperPidNamespace = await fs.readlink(`/proc/${process.pid}/ns/pid`);
      const mountNamespace = await fs.readlink(`/proc/${blocked.pid}/ns/mnt`);
      const reaperMountNamespace = await fs.readlink(`/proc/${process.pid}/ns/mnt`);
      return pidNamespace !== reaperPidNamespace &&
        mountNamespace !== reaperMountNamespace &&
        blocked.ready.reaperVisible === false &&
        hasCompleteCgroupWriteDenials(blocked.ready);
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
  const authority = await loadOrCreateReaperAuthority(
    path.join(registryPath, ".authority.json"),
    {
      requestedReaperBootId:
        process.env.CDX_RELAY_LINUX_REAPER_BOOT_ID
    }
  );
  const registry = createAtomicReaperRegistry(registryPath, {
    ...authority
  });
  return createProtectedLinuxReaper({
    reaperIdentity: `protected-reaper:${process.pid}`,
    reaperBootId: authority.reaperBootId,
    protectedRoot,
    checks,
    cgroups,
    registry,
    watchHarness
  });
}

async function runPayloadShim() {
  const encoded = process.argv[process.argv.indexOf("--payload-shim") + 1];
  const reaperPid = Number(process.argv[process.argv.indexOf("--payload-shim") + 2]);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const status = await fs.readFile("/proc/self/status", "utf8");
  const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]
    ?.trim().split(/\s+/).map(Number) ?? [process.pid];
  const cgroupWriteDenied = {};
  for (const [name, file, value] of [
    ["procs", "cgroup.procs", String(process.pid)],
    ["threads", "cgroup.threads", String(process.pid)],
    ["subtreeControl", "cgroup.subtree_control", "+memory"]
  ]) {
    try {
      await fs.writeFile(path.join("/sys/fs/cgroup", file), value);
      cgroupWriteDenied[name] = false;
    } catch {
      cgroupWriteDenied[name] = true;
    }
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
    cgroupWriteDenied,
    reaperVisible
  })}\n`);
  process.kill(process.pid, "SIGSTOP");
  const terminal = await runBoundedPayload({ payload });
  process.stdout.write(`${JSON.stringify({
    type: "root",
    status: terminal.status,
    signal: terminal.signal,
    stdout: terminal.stdout.toString("base64"),
    stderr: terminal.stderr.toString("base64"),
    error: terminal.error,
    boundaryBreach: terminal.boundaryBreach
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
