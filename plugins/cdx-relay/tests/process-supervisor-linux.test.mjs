import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAtomicReaperRegistry,
  createLinuxCgroupBackend,
  createUnixLinuxReaperClient,
  createProtectedLinuxReaper
} from "./process-supervisor/index.mjs";
import {
  createPidfdHarnessWatcher,
  deriveProtectedTupleKey,
  loadOrCreateReaperAuthority,
  performProtectedBoundaryProbe,
  reportControlLoss,
  runBoundedPayload
} from "./process-supervisor/native/linux/reaper.mjs";

const REQUIRED_CHECKS = Object.freeze({
  controllers: true,
  disposableCgroupKill: true,
  reaperOutsidePayloadPidNamespace: true,
  payloadCgroupFilesReadOnly: true,
  raceResistantHarnessWatch: true,
  outerCgroupLifecycle: true
});

const hashNonce = (nonce) =>
  createHash("sha256").update(nonce).digest("hex");
const protectedOuter = (epoch, runId, root = "/protected") =>
  path.posix.join(
    root,
    deriveProtectedTupleKey("linux-cgroup", epoch, runId)
  );

function createInjectedClient({
  identity = "protected-reaper:injected",
  reaperBootId = "boot-injected",
  checks = REQUIRED_CHECKS,
  recover = { recovered: true, drained: [] },
  mutateResponse,
  cleanupProof
} = {}) {
  const requests = [];
  return {
    identity,
    reaperBootId,
    requests,
    async request(request) {
      requests.push(structuredClone(request));
      let response;
      if (request.operation === "probe") {
        response = {
          version: 1,
          operation: "probe",
          epoch: request.epoch,
          runId: request.runId,
          nonce: request.nonce,
          available: true,
          checks: { ...checks },
          backend: "linux-cgroup",
          reaperIdentity: identity,
          reaperBootId
        };
      } else if (request.operation === "recover") {
        response = {
          version: 1,
          operation: "recover",
          epoch: request.epoch,
          runId: request.runId,
          nonce: request.nonce,
          reaperIdentity: identity,
          backend: "linux-cgroup",
          reaperBootId,
          ...recover
        };
      } else if (request.operation === "launch") {
        response = {
          version: 1,
          operation: "launch",
          epoch: request.epoch,
          runId: request.runId,
          nonce: request.nonce,
          reaperIdentity: identity,
          backend: "linux-cgroup",
          reaperBootId,
          outerCgroup: protectedOuter(request.epoch, request.runId),
          payloadCgroup: path.posix.join(
            protectedOuter(request.epoch, request.runId),
            "payload"
          ),
          pid: 4242,
          child: { pid: 4242 },
          root: Promise.resolve({
            backend: "linux-cgroup",
            status: 0,
            signal: null,
            stdout: Buffer.from("ok"),
            stderr: Buffer.alloc(0)
          })
        };
      } else if (request.operation === "cleanup") {
        response = cleanupProof ?? {
          version: 1,
          operation: "cleanup",
          level: "kernel-drained",
          epoch: request.epoch,
          runId: request.runId,
          nonceHash: hashNonce(request.nonce),
          proofTokenHash: request.payload.proofToken
            ? hashNonce(request.payload.proofToken)
            : "missing",
          outerCgroup: request.payload.outerCgroup,
          populated: 0,
          backend: "linux-cgroup",
          reaperIdentity: identity,
          reaperBootId,
          drainedAt: "2026-07-26T00:00:00.000Z"
        };
      } else if (request.operation === "shutdown") {
        response = {
          version: 1,
          operation: "shutdown",
          epoch: request.epoch,
          runId: request.runId,
          nonce: request.nonce,
          reaperIdentity: identity,
          backend: "linux-cgroup",
          reaperBootId,
          stopped: true
        };
      }
      return mutateResponse?.(response, request) ?? response;
    }
  };
}

const launchSpec = Object.freeze({
  command: process.execPath,
  args: ["-e", ""],
  shell: false,
  epoch: "epoch-a",
  runId: "run-a",
  nonce: "nonce-a",
  backend: "linux-cgroup"
});

test("atomic registry authenticates the complete record before returning it", async () => {
  const registryPath = await fs.mkdtemp(path.join(os.tmpdir(), "cdx-registry-"));
  await fs.chmod(registryPath, 0o700);
  try {
    const expectedUid = (await fs.stat(registryPath)).uid;
    const registry = createAtomicReaperRegistry(registryPath, {
      authenticationKey: Buffer.alloc(32, 7),
      reaperBootId: "boot-test",
      expectedUid,
      enforcePosixMetadata: false
    });
    const entry = {
      backend: "linux-cgroup",
      reaperBootId: "boot-test",
      epoch: "epoch-a",
      runId: "run-a",
      nonceHash: hashNonce("nonce-a"),
      harnessPid: 123,
      harnessStartTime: "456",
      outerCgroup: "/protected/epoch-a-run-a",
      payloadCgroup: "/protected/epoch-a-run-a/payload",
      state: "running"
    };
    await registry.write(entry);
    assert.deepEqual(await registry.list(), [entry]);

    const [name] = await fs.readdir(registryPath);
    const file = path.join(registryPath, name);
    const forged = JSON.parse(await fs.readFile(file, "utf8"));
    forged.outerCgroup = "/attacker/forged";
    await fs.writeFile(file, JSON.stringify(forged));
    await fs.chmod(file, 0o600);

    await assert.rejects(
      registry.list(),
      (error) => error?.code === "REGISTRY_AUTHENTICATION_FAILED"
    );
  } finally {
    await fs.chmod(registryPath, 0o700).catch(() => {});
    await fs.rm(registryPath, { recursive: true, force: true });
  }
});

test("backend epoch and run tuples cannot alias registry or cgroup keys", async () => {
  const left = {
    backend: "linux-cgroup",
    epoch: "a-b",
    runId: "c"
  };
  const right = {
    backend: "linux-cgroup",
    epoch: "a",
    runId: "b-c"
  };
  assert.notEqual(
    deriveProtectedTupleKey(left.backend, left.epoch, left.runId),
    deriveProtectedTupleKey(right.backend, right.epoch, right.runId)
  );
  assert.notEqual(
    deriveProtectedTupleKey(left.backend, left.epoch, left.runId),
    deriveProtectedTupleKey("other-backend", left.epoch, left.runId)
  );

  const registryPath = await fs.mkdtemp(path.join(os.tmpdir(), "cdx-tuple-"));
  try {
    const registry = createAtomicReaperRegistry(registryPath, {
      authenticationKey: Buffer.alloc(32, 9),
      reaperBootId: "boot-test",
      enforcePosixMetadata: false
    });
    await registry.write({ ...left, reaperBootId: "boot-test", marker: "left" });
    await registry.write({ ...right, reaperBootId: "boot-test", marker: "right" });

    const records = await registry.list();

    assert.equal(records.length, 2);
    assert.deepEqual(
      new Set(records.map((record) => record.marker)),
      new Set(["left", "right"])
    );
    const leftName =
      `${deriveProtectedTupleKey(left.backend, left.epoch, left.runId)}.json`;
    await fs.rename(
      path.join(registryPath, leftName),
      path.join(registryPath, "renamed.json")
    );
    await assert.rejects(
      registry.list(),
      (error) => error?.code === "REGISTRY_AUTHENTICATION_FAILED"
    );
  } finally {
    await fs.rm(registryPath, { recursive: true, force: true });
  }
});

test("Linux registry refuses symlinks and unsafe protected-directory metadata", {
  skip: process.platform !== "linux"
}, async () => {
  const registryPath = await fs.mkdtemp(path.join(os.tmpdir(), "cdx-registry-linux-"));
  await fs.chmod(registryPath, 0o700);
  try {
    const expectedUid = (await fs.stat(registryPath)).uid;
    const registry = createAtomicReaperRegistry(registryPath, {
      authenticationKey: Buffer.alloc(32, 9),
      reaperBootId: "boot-linux",
      expectedUid
    });
    const entry = {
      backend: "linux-cgroup",
      reaperBootId: "boot-linux",
      epoch: "epoch-a",
      runId: "run-a",
      nonceHash: hashNonce("nonce-a"),
      proofTokenHash: hashNonce("proof-a"),
      proofConsumed: false,
      harnessPid: 123,
      harnessStartTime: "456",
      outerCgroup: "/protected/epoch-a-run-a",
      payloadCgroup: "/protected/epoch-a-run-a/payload",
      state: "running"
    };
    await registry.write(entry);
    const [target] = (await fs.readdir(registryPath))
      .filter((name) => name.endsWith(".json"));
    await fs.symlink(target, path.join(registryPath, "forged.json"));
    await assert.rejects(
      registry.list(),
      (error) => error?.code === "REGISTRY_INSECURE"
    );
    await fs.unlink(path.join(registryPath, "forged.json"));
    await fs.chmod(registryPath, 0o755);
    await assert.rejects(
      registry.list(),
      (error) => error?.code === "REGISTRY_INSECURE"
    );
  } finally {
    await fs.chmod(registryPath, 0o700).catch(() => {});
    await fs.rm(registryPath, { recursive: true, force: true });
  }
});

test("protected reaper restart reloads one durable boot authority", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cdx-authority-"));
  const authorityPath = path.join(directory, "authority.json");
  try {
    const first = await loadOrCreateReaperAuthority(authorityPath, {
      enforcePosixMetadata: false,
      hostBootId: "host-boot-a",
      requestedReaperBootId: "reaper-boot-a"
    });
    const second = await loadOrCreateReaperAuthority(authorityPath, {
      enforcePosixMetadata: false,
      hostBootId: "host-boot-a",
      requestedReaperBootId: "reaper-boot-a"
    });

    assert.equal(first.reaperBootId, second.reaperBootId);
    assert.equal(first.reaperBootId, "reaper-boot-a");
    assert.deepEqual(first.authenticationKey, second.authenticationKey);
    assert.match(first.reaperBootId, /^[A-Za-z0-9._-]+$/);
    assert.equal(first.authenticationKey.length, 32);
    await assert.rejects(
      loadOrCreateReaperAuthority(authorityPath, {
        enforcePosixMetadata: false,
        hostBootId: "host-boot-b",
        requestedReaperBootId: "reaper-boot-a"
      }),
      (error) => error?.code === "REAPER_HOST_BOOT_CHANGED"
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("protected shim bounds hostile streaming output before accumulation", async () => {
  const breaches = [];
  const startedAt = Date.now();
  const root = await runBoundedPayload({
    payload: {
      command: process.execPath,
      args: ["-e", "setInterval(()=>process.stdout.write('x'.repeat(4096)),0)"],
      env: process.env,
      maxBuffer: 1024,
      timeout: 5000
    },
    onBoundaryBreach(reason) {
      breaches.push(reason);
    }
  });

  assert.equal(root.error?.code, "ENOBUFS");
  assert.ok(root.stdout.length <= 1024);
  assert.ok(root.stderr.length <= 1024);
  assert.deepEqual(breaches, ["output-limit"]);
  assert.ok(Date.now() - startedAt < 3000);
});

test("protected shim enforces a hard runtime cap for a never-exit payload", async () => {
  const breaches = [];
  const startedAt = Date.now();
  const root = await runBoundedPayload({
    payload: {
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: process.env,
      maxBuffer: 1024,
      timeout: 50
    },
    onBoundaryBreach(reason) {
      breaches.push(reason);
    }
  });

  assert.equal(root.error?.code, "ETIMEDOUT");
  assert.deepEqual(breaches, ["runtime-limit"]);
  assert.ok(Date.now() - startedAt < 1000);
});

test("pidfd watcher accepts only a complete bounded READY line", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => true;
  const watcherPromise = createPidfdHarnessWatcher({
    entry: {
      harnessPid: 123,
      harnessStartTime: "456"
    },
    onDeath() {},
    spawnWatcher() {
      return child;
    },
    readyLimit: 16,
    readyTimeoutMs: 1000
  });
  child.stdout.write("RE");
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write("ADY\n");

  const watcher = await watcherPromise;

  assert.equal(typeof watcher.close, "function");
  watcher.close();
});

test("strict capability probe performs the complete disposable boundary itself", async () => {
  const events = [];
  const result = await performProtectedBoundaryProbe({
    protectedRoot: "/protected",
    accessControllers: async () => events.push("controllers"),
    cgroups: {
      async createRun() { events.push("create"); },
      async hasCgroupKill() { events.push("cgroup.kill"); return true; },
      async spawnBlockedShim() {
        events.push("spawn");
        return {
          pid: 77,
          launcherPid: 76,
          ready: {
            reaperVisible: false,
            cgroupWriteDenied: {
              procs: true,
              threads: true,
              subtreeControl: true
            }
          },
          root: new Promise(() => {})
        };
      },
      async migrateBlockedShim() { events.push("migrate"); },
      async validatePayloadMembership() { events.push("membership"); return true; },
      async validateRestrictedNamespace() { events.push("namespace"); return true; },
      async releaseShim() { events.push("release"); },
      async killOuter() { events.push("kill"); },
      async readOuterEvents() { events.push("populated"); return { populated: 0 }; },
      async removeRun() { events.push("remove"); }
    },
    readStartTime: async () => "start-77",
    async watchHarness(entry) {
      events.push(`pidfd:${entry.harnessStartTime}`);
      return {
        async close() {
          events.push("watch-close-start");
          await new Promise((resolve) => setImmediate(resolve));
          events.push("watch-close");
        }
      };
    }
  });

  assert.deepEqual(result, REQUIRED_CHECKS);
  assert.deepEqual(events, [
    "controllers",
    "create",
    "cgroup.kill",
    "spawn",
    "migrate",
    "membership",
    "namespace",
    "pidfd:start-77",
    "release",
    "kill",
    "populated",
    "watch-close-start",
    "watch-close",
    "remove"
  ]);
});

test("writable delegation without protected isolation is unavailable", async () => {
  const client = createInjectedClient({
    checks: {
      ...REQUIRED_CHECKS,
      payloadCgroupFilesReadOnly: false,
      writableDelegatedSubtree: true
    }
  });
  const backend = createLinuxCgroupBackend({
    platform: "linux",
    reaperClient: client
  });

  const probe = await backend.probe();

  assert.equal(probe.available, false);
  assert.equal(probe.code, "CAPABILITY_UNAVAILABLE");
  assert.match(probe.reason, /payload.*cgroup|namespace|protected/i);
  assert.equal(
    client.requests.some((request) => request.operation === "recover"),
    false,
    "an unsafe probe must not recover or launch state"
  );
});

test("reaper refuses launch after any protected-boundary prerequisite fails", async () => {
  const { reaper } = createReaperHarness({
    checks: {
      ...REQUIRED_CHECKS,
      payloadCgroupFilesReadOnly: false,
      writableDelegatedSubtree: true
    }
  });
  assert.equal((await reaper.handleRequest(request("probe"))).available, false);
  await reaper.handleRequest(request("recover"));

  await assert.rejects(
    reaper.handleRequest(request("launch", {
      payload: {
        command: process.execPath,
        args: [],
        harnessPid: 111,
        harnessStartTime: "222"
      }
    })),
    (error) => error?.code === "CAPABILITY_UNAVAILABLE"
  );
});

test("missing protected reaper is unavailable", async () => {
  const backend = createLinuxCgroupBackend({
    platform: "linux",
    reaperClient: null
  });

  const probe = await backend.probe();

  assert.equal(probe.available, false);
  assert.equal(probe.code, "CAPABILITY_UNAVAILABLE");
  assert.match(probe.reason, /reaper/i);
});

test("reaper identity components cannot escape the protected cgroup root", async () => {
  const { reaper } = createReaperHarness();

  await assert.rejects(
    reaper.handleRequest(request("probe", { runId: "../../../escape" })),
    (error) => error?.code === "PROTOCOL_INVALID_MESSAGE"
  );
});

test("nonce or epoch mismatch poisons the backend", async () => {
  for (const field of ["nonce", "epoch"]) {
    const client = createInjectedClient({
      mutateResponse(response, request) {
        if (request.operation === "launch") {
          return { ...response, [field]: `${response[field]}-attacker` };
        }
        return response;
      }
    });
    const backend = createLinuxCgroupBackend({
      platform: "linux",
      reaperClient: client
    });
    assert.equal((await backend.probe()).available, true);

    await assert.rejects(
      backend.launch(launchSpec),
      (error) => error?.code === "PROTOCOL_IDENTITY_MISMATCH"
    );
    assert.throws(
      () => backend.assertHealthy(),
      (error) => error?.code === "PROTOCOL_IDENTITY_MISMATCH"
    );
    await assert.rejects(
      backend.launch({ ...launchSpec, runId: `run-after-${field}` }),
      (error) => error?.code === "PROTOCOL_IDENTITY_MISMATCH"
    );
  }
});

test("cross-boot cleanup proof poisons the backend", async () => {
  const client = createInjectedClient({
    mutateResponse(response, request) {
      return request.operation === "cleanup"
        ? { ...response, reaperBootId: "attacker-boot" }
        : response;
    }
  });
  const backend = createLinuxCgroupBackend({
    platform: "linux",
    reaperClient: client
  });
  assert.equal((await backend.probe()).available, true);
  const launched = await backend.launch(launchSpec);

  await assert.rejects(
    launched.cleanup(),
    (error) => [
      "PROTOCOL_IDENTITY_MISMATCH",
      "CLEANUP_UNPROVEN"
    ].includes(error?.code)
  );
  assert.throws(() => backend.assertHealthy());
});

test("every backend request binds backend and reaper boot identities", async () => {
  const client = createInjectedClient();
  const backend = createLinuxCgroupBackend({
    platform: "linux",
    reaperClient: client
  });
  await backend.probe();
  const launched = await backend.launch({
    command: process.execPath,
    args: [],
    shell: false,
    epoch: "bound-epoch",
    runId: "bound-run",
    nonce: "bound-nonce",
    backend: "linux-cgroup"
  });
  await launched.cleanup();

  assert.ok(client.requests.length >= 4);
  for (const sent of client.requests) {
    assert.equal(sent.backend, "linux-cgroup");
    assert.equal(sent.reaperBootId, "boot-injected");
  }
});

test("protected reaper rejects request backend or boot mismatch before operation", async () => {
  const { reaper, events } = createReaperHarness();

  for (const mismatch of [
    { backend: "other-backend", reaperBootId: "boot-test" },
    { backend: "linux-cgroup", reaperBootId: "other-boot" }
  ]) {
    await assert.rejects(
      reaper.handleRequest(request("probe", mismatch)),
      (error) => error?.code === "PROTOCOL_IDENTITY_MISMATCH"
    );
  }
  assert.deepEqual(events, []);
});

test("leaf populated zero is insufficient when the outer cgroup remains populated", async () => {
  const client = createInjectedClient({
    mutateResponse(response, request) {
      return request.operation === "cleanup"
        ? { ...response, payloadPopulated: 0, populated: 1 }
        : response;
    }
  });
  const backend = createLinuxCgroupBackend({
    platform: "linux",
    reaperClient: client
  });
  assert.equal((await backend.probe()).available, true);
  const launched = await backend.launch(launchSpec);

  await assert.rejects(
    launched.cleanup(),
    (error) => error?.code === "CLEANUP_UNPROVEN"
  );
  assert.throws(
    () => backend.assertHealthy(),
    (error) => error?.code === "CLEANUP_UNPROVEN"
  );
});

test("cleanup accepts only authenticated outer-cgroup populated zero", async () => {
  const client = createInjectedClient();
  const backend = createLinuxCgroupBackend({
    platform: "linux",
    reaperClient: client
  });
  assert.equal((await backend.probe()).available, true);
  const launched = await backend.launch(launchSpec);

  const proof = await launched.cleanup();
  const launchedRequest = client.requests.find(
    (item) => item.operation === "launch" && item.runId === launchSpec.runId
  );

  assert.deepEqual(proof, {
    backend: "linux-cgroup",
    level: "kernel-drained",
    epoch: launchSpec.epoch,
    runId: launchSpec.runId,
    nonceHash: hashNonce(launchSpec.nonce),
    proofTokenHash: hashNonce(launchedRequest.payload.proofToken),
    outerCgroup: protectedOuter(launchSpec.epoch, launchSpec.runId),
    populated: 0,
    reaperBootId: "boot-injected",
    reaperIdentity: client.identity,
    drainedAt: "2026-07-26T00:00:00.000Z"
  });
});

test("protected reaper consumes each cleanup proof token exactly once", async () => {
  const { reaper } = createReaperHarness();
  await reaper.handleRequest(request("probe"));
  await reaper.handleRequest(request("recover"));
  await reaper.handleRequest(request("launch", {
    payload: {
      command: process.execPath,
      args: [],
      harnessPid: 111,
      harnessStartTime: "222",
      proofToken: "one-time-proof-token"
    }
  }));
  const cleanup = request("cleanup", {
    payload: {
      outerCgroup: protectedOuter("epoch-a", "run-a"),
      proofToken: "one-time-proof-token"
    }
  });

  const proof = await reaper.handleRequest(cleanup);
  assert.equal(proof.proofTokenHash, hashNonce("one-time-proof-token"));
  await assert.rejects(
    reaper.handleRequest(cleanup),
    (error) => error?.code === "PROOF_REPLAYED"
  );
});

test("target payload never receives the private registry path or reaper credential", async () => {
  const client = createInjectedClient();
  const backend = createLinuxCgroupBackend({
    platform: "linux",
    reaperClient: client
  });
  assert.equal((await backend.probe()).available, true);
  await backend.launch({
    ...launchSpec,
    env: {
      SAFE_VALUE: "visible",
      CDX_RELAY_LINUX_REAPER_ENDPOINT: "/private/reaper.sock",
      CDX_RELAY_LINUX_REAPER_CREDENTIAL: "raw-secret",
      CDX_RELAY_LINUX_REAPER_REGISTRY: "/private/registry"
    }
  });

  const launch = client.requests.find((request) => request.operation === "launch");
  assert.deepEqual(launch.payload.env, { SAFE_VALUE: "visible" });
});

test("real reaper transport acknowledges launch before root completion", async () => {
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\cdx-relay-linux-${process.pid}-${Date.now()}`
    : `/tmp/cdx-relay-linux-${process.pid}-${Date.now()}.sock`;
  const credential = "transport-test-credential";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const frame = JSON.parse(chunk.slice(0, chunk.indexOf("\n")));
      assert.equal(frame.credential, credential);
      const request = frame.request;
      socket.write(`${JSON.stringify({
        response: {
          version: 1,
          operation: "launch",
          epoch: request.epoch,
          runId: request.runId,
          nonce: request.nonce,
          reaperIdentity: "protected-reaper:transport",
          outerCgroup: "/protected/transport",
          payloadCgroup: "/protected/transport/payload",
          pid: 77
        }
      })}\n`);
      setTimeout(() => socket.end(`${JSON.stringify({
        event: "root",
        root: {
          backend: "linux-cgroup",
          status: 0,
          signal: null,
          stdout: "transport-root",
          stderr: ""
        }
      })}\n`), 50);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  try {
    const client = createUnixLinuxReaperClient({
      endpoint,
      credential,
      reaperBootId: "boot-test",
      timeoutMs: 1000
    });
    const launched = await client.request(request("launch", {
      payload: {
        command: process.execPath,
        args: [],
        harnessPid: process.pid,
        harnessStartTime: "transport"
      }
    }));
    assert.ok(launched.root instanceof Promise);
    assert.equal((await launched.root).stdout, "transport-root");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("reaper transport reports a failed control-loss drain", async () => {
  const reports = [];
  const handled = await reportControlLoss({
    async handleControlLoss() {
      throw new Error("reported control-loss failure");
    }
  }, "run-a", (error) => reports.push(error));

  assert.equal(handled, false);
  assert.match(reports[0]?.message ?? "", /reported control-loss failure/);
});

function createReaperHarness({
  registryEntries = [],
  checks = REQUIRED_CHECKS,
  cgroupOverrides = {},
  watchFactory,
  reaperBootId = "boot-test"
} = {}) {
  const events = [];
  const entries = new Map(
    registryEntries.map((entry) => [entry.runId, structuredClone(entry)])
  );
  const watchers = new Map();
  const cgroups = {
    async createRun(entry) {
      events.push(`create:${entry.runId}`);
    },
    async spawnBlockedShim(entry, payload) {
      events.push(`spawn:${entry.runId}`);
      return { pid: 9001, root: Promise.resolve(payload.root ?? {}) };
    },
    async migrateBlockedShim(entry) {
      events.push(`migrate:${entry.runId}`);
    },
    async validatePayloadMembership(entry) {
      events.push(`membership:${entry.runId}`);
      return true;
    },
    async validateRestrictedNamespace(entry) {
      events.push(`namespace:${entry.runId}`);
      return true;
    },
    async releaseShim(entry) {
      events.push(`release:${entry.runId}`);
    },
    async killOuter(entry) {
      events.push(`kill:${entry.runId}`);
    },
    async readOuterEvents(entry) {
      events.push(`events:${entry.runId}`);
      return { populated: 0 };
    },
    async removeRun(entry) {
      events.push(`remove:${entry.runId}`);
    },
    ...cgroupOverrides
  };
  const registry = {
    async list() {
      return [...entries.values()].map((entry) => structuredClone(entry));
    },
    async write(entry) {
      entries.set(entry.runId, structuredClone(entry));
      events.push(`registry:${entry.runId}:${entry.state}`);
    }
  };
  const reaper = createProtectedLinuxReaper({
    reaperIdentity: "protected-reaper:test",
    reaperBootId,
    protectedRoot: "/protected",
    checks: async () => ({ ...checks }),
    cgroups,
    registry,
    watchHarness(entry, onDeath) {
      watchers.set(entry.runId, onDeath);
      return watchFactory?.(entry, onDeath) ?? { close() {} };
    },
    now: () => new Date("2026-07-26T00:00:00.000Z")
  });
  return { reaper, events, entries, watchers };
}

function request(operation, {
  epoch = "epoch-a",
  runId = "run-a",
  nonce = "nonce-a",
  backend = "linux-cgroup",
  reaperBootId =
    process.env.CDX_RELAY_LINUX_REAPER_BOOT_ID ?? "boot-test",
  payload = {}
} = {}) {
  return {
    version: 1,
    operation,
    epoch,
    runId,
    nonce,
    backend,
    reaperBootId,
    payload: ["launch", "cleanup"].includes(operation)
      ? { proofToken: "default-one-time-proof-token", ...payload }
      : payload
  };
}

test("coordinator death causes independent reaper cleanup", async () => {
  const { reaper, events, entries, watchers } = createReaperHarness();
  await reaper.handleRequest(request("probe"));
  await reaper.handleRequest(request("recover"));
  await reaper.handleRequest(request("launch", {
    payload: {
      command: process.execPath,
      args: ["-e", ""],
      harnessPid: 111,
      harnessStartTime: "222"
    }
  }));

  watchers.get("run-a")();
  const deadline = Date.now() + 1000;
  while (entries.get("run-a")?.state !== "drained" && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.ok(events.includes("kill:run-a"));
  assert.ok(events.includes("events:run-a"));
  assert.equal(entries.get("run-a").state, "drained");
});

test("simultaneous cleanup and harness death join one idempotent drain", async () => {
  const { reaper, events, watchers } = createReaperHarness();
  await reaper.handleRequest(request("probe"));
  await reaper.handleRequest(request("recover"));
  await reaper.handleRequest(request("launch", {
    payload: {
      command: process.execPath,
      args: [],
      harnessPid: 111,
      harnessStartTime: "222"
    }
  }));

  await Promise.all([
    watchers.get("run-a")(),
    reaper.handleRequest(request("cleanup", {
      payload: { outerCgroup: protectedOuter("epoch-a", "run-a") }
    }))
  ]);

  assert.equal(events.filter((event) => event === "kill:run-a").length, 1);
  assert.equal(events.filter((event) => event === "events:run-a").length, 1);
  assert.equal(events.filter((event) => event === "remove:run-a").length, 1);
});

test("concurrent cleanup consumes the one-time proof token before drain awaits", async () => {
  let signalKillStarted;
  const killStarted = new Promise((resolve) => {
    signalKillStarted = resolve;
  });
  let releaseKill;
  const killReleased = new Promise((resolve) => {
    releaseKill = resolve;
  });
  const { reaper } = createReaperHarness({
    cgroupOverrides: {
      async killOuter() {
        signalKillStarted();
        await killReleased;
      }
    }
  });
  await reaper.handleRequest(request("probe"));
  await reaper.handleRequest(request("recover"));
  const launched = await reaper.handleRequest(request("launch", {
    payload: {
      command: process.execPath,
      args: [],
      harnessPid: 111,
      harnessStartTime: "222"
    }
  }));
  const cleanupRequest = request("cleanup", {
    payload: { outerCgroup: launched.outerCgroup }
  });

  const first = reaper.handleRequest(cleanupRequest);
  await killStarted;
  const replay = assert.rejects(
    reaper.handleRequest(cleanupRequest),
    (error) => error?.code === "PROOF_REPLAYED"
  );
  releaseKill();

  const [proof] = await Promise.all([first, replay]);
  assert.equal(proof.level, "kernel-drained");
});

test("watcher drain failure is handled and latched without an exposed rejection", async () => {
  const { reaper, watchers } = createReaperHarness({
    cgroupOverrides: {
      async removeRun() {
        throw new Error("injected removal failure");
      }
    }
  });
  await reaper.handleRequest(request("probe"));
  await reaper.handleRequest(request("recover"));
  await reaper.handleRequest(request("launch", {
    payload: {
      command: process.execPath,
      args: [],
      harnessPid: 111,
      harnessStartTime: "222"
    }
  }));

  const returned = watchers.get("run-a")();
  returned?.catch?.(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(returned, undefined);
  assert.throws(
    () => reaper.assertHealthy(),
    /injected removal failure/
  );
});

test("protected drain awaits and latches a rejecting asynchronous watcher close", async () => {
  let closeAwaited = false;
  const { reaper, events } = createReaperHarness({
    watchFactory() {
      return {
        close() {
          return {
            then(_resolve, reject) {
              closeAwaited = true;
              reject(new Error("injected watcher close failure"));
            }
          };
        }
      };
    }
  });
  await reaper.handleRequest(request("probe"));
  await reaper.handleRequest(request("recover"));
  await reaper.handleRequest(request("launch", {
    payload: {
      command: process.execPath,
      args: [],
      harnessPid: 111,
      harnessStartTime: "222"
    }
  }));

  await assert.rejects(
    reaper.handleRequest(request("cleanup", {
      payload: { outerCgroup: protectedOuter("epoch-a", "run-a") }
    })),
    /injected watcher close failure/
  );

  assert.equal(closeAwaited, true);
  assert.equal(events.includes("remove:run-a"), false);
  assert.throws(() => reaper.assertHealthy(), /injected watcher close failure/);
});

test("control-channel-loss drain failure is latched and returned to the reporter", async () => {
  const { reaper } = createReaperHarness({
    cgroupOverrides: {
      async removeRun() {
        throw new Error("injected control-loss drain failure");
      }
    }
  });
  await reaper.handleRequest(request("probe"));
  await reaper.handleRequest(request("recover"));
  await reaper.handleRequest(request("launch", {
    payload: {
      command: process.execPath,
      args: [],
      harnessPid: 111,
      harnessStartTime: "222"
    }
  }));

  await assert.rejects(
    reaper.handleControlLoss("run-a"),
    /injected control-loss drain failure/
  );
  assert.throws(
    () => reaper.assertHealthy(),
    /injected control-loss drain failure/
  );
});

test("payload runtime or output breach drains the outer cgroup before terminal proof", async () => {
  const { reaper, events, entries } = createReaperHarness();
  await reaper.handleRequest(request("probe"));
  await reaper.handleRequest(request("recover"));
  const launched = await reaper.handleRequest(request("launch", {
    payload: {
      command: process.execPath,
      args: [],
      harnessPid: 111,
      harnessStartTime: "222",
      root: {
        status: null,
        signal: "SIGKILL",
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: { code: "ENOBUFS", message: "bounded" },
        boundaryBreach: "output-limit"
      }
    }
  }));

  const root = await launched.root;

  assert.equal(root.error.code, "ENOBUFS");
  assert.ok(events.includes("kill:run-a"));
  assert.equal(entries.get("run-a").state, "drained");
});

test("stale registry recovery completes before a new launch", async () => {
  const stale = {
    backend: "linux-cgroup",
    reaperBootId: "boot-test",
    epoch: "old-epoch",
    runId: "old-run",
    nonceHash: hashNonce("old-nonce"),
    proofTokenHash: hashNonce("old-proof-token"),
    proofConsumed: false,
    harnessPid: 12,
    harnessStartTime: "34",
    outerCgroup: protectedOuter("old-epoch", "old-run"),
    payloadCgroup: path.posix.join(
      protectedOuter("old-epoch", "old-run"),
      "payload"
    ),
    state: "running"
  };
  const { reaper, events } = createReaperHarness({
    registryEntries: [stale]
  });
  await reaper.handleRequest(request("probe"));
  await assert.rejects(
    reaper.handleRequest(request("launch")),
    (error) => error?.code === "RECOVERY_REQUIRED"
  );

  await reaper.handleRequest(request("recover"));
  await reaper.handleRequest(request("launch", {
    payload: {
      command: process.execPath,
      args: [],
      harnessPid: 111,
      harnessStartTime: "222"
    }
  }));

  assert.ok(events.indexOf("kill:old-run") < events.indexOf("create:run-a"));
});

test("recovery rejects cross-boundary registry records before privileged cleanup", async () => {
  const base = {
    backend: "linux-cgroup",
    reaperBootId: "boot-test",
    epoch: "old-epoch",
    runId: "old-run",
    nonceHash: hashNonce("old-nonce"),
    proofTokenHash: hashNonce("old-proof-token"),
    proofConsumed: false,
    harnessPid: 12,
    harnessStartTime: "34",
    outerCgroup: protectedOuter("old-epoch", "old-run"),
    payloadCgroup: path.posix.join(
      protectedOuter("old-epoch", "old-run"),
      "payload"
    ),
    state: "running"
  };
  for (const forged of [
    { ...base, backend: "other-backend" },
    { ...base, reaperBootId: "other-boot" },
    { ...base, outerCgroup: "/attacker/forged" },
    { ...base, payloadCgroup: "/protected/sibling" },
    { ...base, runId: "../../../escape" }
  ]) {
    const { reaper, events } = createReaperHarness({
      registryEntries: [forged]
    });
    await reaper.handleRequest(request("probe"));

    await assert.rejects(
      reaper.handleRequest(request("recover")),
      (error) => [
        "REGISTRY_INVALID",
        "REGISTRY_AUTHENTICATION_FAILED"
      ].includes(error?.code)
    );
    assert.equal(
      events.some((event) => event.startsWith("kill:")),
      false
    );
  }
});

test("payload migration attempt is rejected and drains the run", async () => {
  const harness = createReaperHarness();
  harness.reaper = createProtectedLinuxReaper({
    reaperIdentity: "protected-reaper:test",
    reaperBootId: "boot-test",
    protectedRoot: "/protected",
    checks: async () => ({ ...REQUIRED_CHECKS }),
    registry: {
      async list() { return []; },
      async write(entry) {
        harness.entries.set(entry.runId, structuredClone(entry));
      }
    },
    cgroups: {
      async createRun() {},
      async spawnBlockedShim() { return { pid: 99, root: Promise.resolve({}) }; },
      async migrateBlockedShim() {},
      async validatePayloadMembership() { return false; },
      async validateRestrictedNamespace() { return true; },
      async releaseShim() {
        assert.fail("an invalid migration must never be released");
      },
      async killOuter(entry) { harness.events.push(`kill:${entry.runId}`); },
      async readOuterEvents() { return { populated: 0 }; },
      async removeRun() {}
    },
    watchHarness() { return { close() {} }; }
  });
  await harness.reaper.handleRequest(request("probe"));
  await harness.reaper.handleRequest(request("recover"));

  await assert.rejects(
    harness.reaper.handleRequest(request("launch", {
      payload: {
        command: process.execPath,
        args: [],
        harnessPid: 111,
        harnessStartTime: "222"
      }
    })),
    (error) => error?.code === "PAYLOAD_MIGRATION_REJECTED"
  );
  assert.ok(harness.events.includes("kill:run-a"));
});

test("raw PID discovery never authorizes cleanup", async () => {
  const { reaper, events } = createReaperHarness();
  await reaper.handleRequest(request("probe"));
  await reaper.handleRequest(request("recover"));

  await assert.rejects(
    reaper.handleRequest(request("cleanup", {
      payload: {
        outerCgroup: "/protected/attacker",
        discoveredPids: [123, 456]
      }
    })),
    (error) => error?.code === "UNAUTHENTICATED_RUN"
  );
  assert.equal(
    events.some((event) => event.startsWith("kill:")),
    false
  );
});

test("Linux strict mode requires a live protected runner", {
  skip: process.env.CDX_RELAY_TEST_LINUX_STRICT !== "1"
}, async () => {
  assert.equal(process.platform, "linux", "strict mode requires Linux");
  let backend = createLinuxCgroupBackend();
  const client = createUnixLinuxReaperClient();
  const probe = await backend.probe();
  assert.equal(
    probe.available,
    true,
    `protected Linux runner unavailable: ${probe.reason ?? "unknown reason"}`
  );
  assert.deepEqual(probe.capabilities, {
    platform: "linux",
    backend: "linux-cgroup",
    mode: "host-strict",
    containment: "kernel",
    cleanupProof: "kernel-drained",
    supportsDetachedDescendants: true
  });
  const stat = await import("node:fs/promises").then(({ readFile }) =>
    readFile(`/proc/${process.pid}/stat`, "utf8"));
  const harnessStartTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const audit = async (runId) => {
    const result = await client.request(request("probe", {
      epoch: `audit-${Date.now()}`,
      runId: `audit-${process.pid}`,
      nonce: `audit-nonce-${Date.now()}`
    }));
    return {
      probe: result,
      entry: result.registry?.find((candidate) => candidate.runId === runId)
    };
  };
  const waitFor = async (predicate, message, timeout = 10_000) => {
    const deadline = Date.now() + timeout;
    let observed;
    while (Date.now() < deadline) {
      observed = await predicate();
      if (observed) return observed;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`${message}; last observation: ${JSON.stringify(observed)}`);
  };
  const initialReaperProbe = (await audit("__no-active-run__")).probe;

  await assert.rejects(
    client.request(request("launch", {
      epoch: `pid-mismatch-${Date.now()}`,
      runId: `pid-mismatch-${process.pid}`,
      nonce: `pid-mismatch-nonce-${Date.now()}`,
      payload: {
        command: process.execPath,
        args: ["-e", ""],
        env: {},
        harnessPid: process.pid,
        harnessStartTime: `${harnessStartTime}-wrong`
      }
    })),
    (error) => error?.code === "HARNESS_WATCH_UNAVAILABLE"
  );

  const staleIdentity = {
    epoch: `stale-${Date.now()}`,
    runId: `stale-${process.pid}`,
    nonce: `stale-nonce-${Date.now()}`
  };
  const staleLaunch = await client.request(request("launch", {
    ...staleIdentity,
    payload: {
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: {},
      harnessPid: process.pid,
      harnessStartTime
    }
  }));
  void staleLaunch.root.catch(() => {});
  const liveStale = await waitFor(async () => {
    const state = (await audit(staleIdentity.runId)).entry;
    return state?.state === "running" && state.populated === 1 &&
      state.pids?.length > 0 ? state : undefined;
  }, "stale run never became observably populated");
  const oldReaperPid = Number(
    initialReaperProbe.reaperIdentity.split(":").at(-1)
  );
  assert.equal(Number.isSafeInteger(oldReaperPid), true);
  const killed = spawnSync("sudo", ["-n", "kill", "-9", String(oldReaperPid)], {
    encoding: "utf8"
  });
  assert.equal(killed.status, 0, killed.stderr);

  const reaperScript = fileURLToPath(new URL(
    "./process-supervisor/native/linux/reaper.mjs",
    import.meta.url
  ));
  const requiredReaperEnvironment = [
    "CDX_RELAY_LINUX_REAPER_ENDPOINT",
    "CDX_RELAY_LINUX_REAPER_CREDENTIAL",
    "CDX_RELAY_LINUX_REAPER_BOOT_ID",
    "CDX_RELAY_LINUX_PROTECTED_ROOT",
    "CDX_RELAY_LINUX_REAPER_REGISTRY",
    "CDX_RELAY_LINUX_PAYLOAD_UID",
    "CDX_RELAY_LINUX_PAYLOAD_GID",
    "CDX_RELAY_LINUX_SOCKET_UID",
    "CDX_RELAY_LINUX_SOCKET_GID"
  ];
  const environmentArguments = requiredReaperEnvironment.map((name) => {
    assert.notEqual(process.env[name], undefined, `${name} must be configured`);
    return `${name}=${process.env[name]}`;
  });
  const restartedReaper = spawn("sudo", [
    "-n",
    "env",
    ...environmentArguments,
    process.execPath,
    reaperScript,
    "--serve"
  ], {
    detached: true,
    stdio: "ignore"
  });
  restartedReaper.unref();
  const restartedProbe = await waitFor(async () => {
    try {
      return (await audit(staleIdentity.runId)).probe;
    } catch {
      return undefined;
    }
  }, "replacement reaper did not become ready");
  assert.notEqual(
    restartedProbe.reaperIdentity,
    initialReaperProbe.reaperIdentity
  );
  assert.equal(
    restartedProbe.reaperBootId,
    initialReaperProbe.reaperBootId
  );

  const recovery = await client.request(request("recover", {
    epoch: `recovery-${Date.now()}`,
    runId: `recovery-${process.pid}`,
    nonce: `recovery-nonce-${Date.now()}`
  }));
  assert.ok(recovery.drained.includes(staleIdentity.runId));
  const recoveredStale = (await audit(staleIdentity.runId)).entry;
  assert.deepEqual(recoveredStale, {
    epoch: staleIdentity.epoch,
    runId: staleIdentity.runId,
    state: "drained",
    populated: 0,
    pids: []
  });
  for (const pid of liveStale.pids) {
    await assert.rejects(fs.access(`/proc/${pid}`), { code: "ENOENT" });
  }
  backend = createLinuxCgroupBackend();
  assert.equal((await backend.probe()).available, true);

  const identity = {
    epoch: `live-${Date.now()}`,
    runId: `run-${process.pid}`,
    nonce: `nonce-${Date.now()}`,
    backend: "linux-cgroup"
  };
  const launched = await backend.launch({
    command: process.execPath,
    args: ["-e", "process.stdout.write('linux-strict')"],
    shell: false,
    ...identity
  });
  const root = await launched.root;
  assert.equal(root.status, 0);
  assert.equal(Buffer.from(root.stdout).toString(), "linux-strict");
  const proof = await launched.cleanup();
  assert.equal(proof.level, "kernel-drained");
  assert.equal(proof.populated, 0);
  assert.equal(
    proof.outerCgroup,
    protectedOuter(
      identity.epoch,
      identity.runId,
      process.env.CDX_RELAY_LINUX_PROTECTED_ROOT
    )
  );

  const migrationIdentity = {
    epoch: `migration-${Date.now()}`,
    runId: `migration-${process.pid}`,
    nonce: `migration-nonce-${Date.now()}`,
    backend: "linux-cgroup"
  };
  const migration = await backend.launch({
    command: process.execPath,
    args: ["-e", [
      "const fs=require('node:fs');",
      "try{fs.writeFileSync(process.env.ATTEMPT_CGROUP,String(process.pid));",
      "process.stdout.write('writable')}catch{process.stdout.write('denied')}"
    ].join("")],
    env: {
      ATTEMPT_CGROUP: path.join(
        protectedOuter(
          migrationIdentity.epoch,
          migrationIdentity.runId,
          process.env.CDX_RELAY_LINUX_PROTECTED_ROOT
        ),
        "cgroup.procs"
      )
    },
    shell: false,
    ...migrationIdentity
  });
  assert.equal(Buffer.from((await migration.root).stdout).toString(), "denied");
  assert.equal((await migration.cleanup()).populated, 0);

  const backendUrl = new URL(
    "./process-supervisor/backends/linux-cgroup.mjs",
    import.meta.url
  ).href;
  const deathIdentity = {
    epoch: `death-${Date.now()}`,
    runId: `death-${process.pid}`,
    nonce: `death-nonce-${Date.now()}`
  };
  const forkingPayload = [
    "const {spawn}=require('node:child_process');",
    "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],",
    "{detached:true,stdio:'ignore'}).unref();",
    "setInterval(()=>{},1000)"
  ].join("");
  const source = [
    `import { createLinuxCgroupBackend } from ${JSON.stringify(backendUrl)};`,
    `const backend=createLinuxCgroupBackend();`,
    `await backend.probe();`,
    `const launched=await backend.launch(${JSON.stringify({
      command: process.execPath,
      args: ["-e", forkingPayload],
      shell: false,
      backend: "linux-cgroup",
      ...deathIdentity
    })});`,
    "process.send({outerCgroup:launched.outerCgroup});"
  ].join("\n");
  const coordinator = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    source
  ], {
    env: process.env,
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  await new Promise((resolve, reject) => {
    coordinator.once("error", reject);
    coordinator.once("message", resolve);
  });
  const liveDeath = await waitFor(async () => {
    const state = (await audit(deathIdentity.runId)).entry;
    return state?.state === "running" && state.populated === 1 &&
      state.pids?.length >= 2 ? state : undefined;
  }, "forking workload never became observably populated");
  coordinator.kill("SIGKILL");
  await new Promise((resolve) => coordinator.once("exit", resolve));
  const deathState = await waitFor(async () => {
    const state = (await audit(deathIdentity.runId)).entry;
    return state?.state === "drained" && state.populated === 0 &&
      state.pids?.length === 0 ? state : undefined;
  }, "coordinator death did not drain the forking workload");
  assert.equal(deathState.state, "drained");
  for (const pid of liveDeath.pids) {
    await assert.rejects(fs.access(`/proc/${pid}`), { code: "ENOENT" });
  }
});
