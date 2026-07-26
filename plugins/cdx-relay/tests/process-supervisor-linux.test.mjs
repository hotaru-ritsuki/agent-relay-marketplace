import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import test from "node:test";

import {
  createLinuxCgroupBackend,
  createUnixLinuxReaperClient,
  createProtectedLinuxReaper
} from "./process-supervisor/index.mjs";

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

function createInjectedClient({
  identity = "protected-reaper:injected",
  checks = REQUIRED_CHECKS,
  recover = { recovered: true, drained: [] },
  mutateResponse,
  cleanupProof
} = {}) {
  const requests = [];
  return {
    identity,
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
          reaperIdentity: identity
        };
      } else if (request.operation === "recover") {
        response = {
          version: 1,
          operation: "recover",
          epoch: request.epoch,
          runId: request.runId,
          nonce: request.nonce,
          reaperIdentity: identity,
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
          outerCgroup: `/protected/${request.epoch}-${request.runId}`,
          payloadCgroup: `/protected/${request.epoch}-${request.runId}/payload`,
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
          outerCgroup: request.payload.outerCgroup,
          populated: 0,
          reaperIdentity: identity,
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

test("leaf populated zero is insufficient when the outer cgroup remains populated", async () => {
  const client = createInjectedClient({
    cleanupProof: {
      version: 1,
      operation: "cleanup",
      level: "kernel-drained",
      epoch: launchSpec.epoch,
      runId: launchSpec.runId,
      nonceHash: hashNonce(launchSpec.nonce),
      outerCgroup: `/protected/${launchSpec.epoch}-${launchSpec.runId}`,
      payloadPopulated: 0,
      populated: 1,
      reaperIdentity: "protected-reaper:injected",
      drainedAt: "2026-07-26T00:00:00.000Z"
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

  assert.deepEqual(proof, {
    backend: "linux-cgroup",
    level: "kernel-drained",
    epoch: launchSpec.epoch,
    runId: launchSpec.runId,
    nonceHash: hashNonce(launchSpec.nonce),
    outerCgroup: `/protected/${launchSpec.epoch}-${launchSpec.runId}`,
    populated: 0,
    reaperIdentity: client.identity,
    drainedAt: "2026-07-26T00:00:00.000Z"
  });
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

function createReaperHarness({
  registryEntries = [],
  checks = REQUIRED_CHECKS
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
    }
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
    protectedRoot: "/protected",
    checks: async () => ({ ...checks }),
    cgroups,
    registry,
    watchHarness(entry, onDeath) {
      watchers.set(entry.runId, onDeath);
      return { close() {} };
    },
    now: () => new Date("2026-07-26T00:00:00.000Z")
  });
  return { reaper, events, entries, watchers };
}

function request(operation, {
  epoch = "epoch-a",
  runId = "run-a",
  nonce = "nonce-a",
  payload = {}
} = {}) {
  return { version: 1, operation, epoch, runId, nonce, payload };
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

  await watchers.get("run-a")();

  assert.ok(events.includes("kill:run-a"));
  assert.ok(events.includes("events:run-a"));
  assert.equal(entries.get("run-a").state, "drained");
});

test("stale registry recovery completes before a new launch", async () => {
  const stale = {
    epoch: "old-epoch",
    runId: "old-run",
    nonceHash: hashNonce("old-nonce"),
    harnessPid: 12,
    harnessStartTime: "34",
    outerCgroup: "/protected/old-epoch-old-run",
    payloadCgroup: "/protected/old-epoch-old-run/payload",
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

test("payload migration attempt is rejected and drains the run", async () => {
  const harness = createReaperHarness();
  harness.reaper = createProtectedLinuxReaper({
    reaperIdentity: "protected-reaper:test",
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
  const backend = createLinuxCgroupBackend();
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
  const client = createUnixLinuxReaperClient();
  const stat = await import("node:fs/promises").then(({ readFile }) =>
    readFile(`/proc/${process.pid}/stat`, "utf8"));
  const harnessStartTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const staleIdentity = {
    epoch: `stale-${Date.now()}`,
    runId: `stale-${process.pid}`,
    nonce: `stale-nonce-${Date.now()}`
  };
  await client.request(request("launch", {
    ...staleIdentity,
    payload: {
      command: process.execPath,
      args: ["-e", ""],
      env: {},
      harnessPid: process.pid,
      harnessStartTime
    }
  }));
  const recovery = await client.request(request("recover", {
    epoch: `recovery-${Date.now()}`,
    runId: `recovery-${process.pid}`,
    nonce: `recovery-nonce-${Date.now()}`
  }));
  assert.ok(recovery.drained.includes(staleIdentity.runId));

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
  assert.equal(proof.outerCgroup.endsWith(`${identity.epoch}-${identity.runId}`), true);

  const migration = await backend.launch({
    command: process.execPath,
    args: ["-e", [
      "const fs=require('node:fs');",
      "try{fs.writeFileSync('/sys/fs/cgroup/cgroup.procs',String(process.pid));",
      "process.stdout.write('writable')}catch{process.stdout.write('denied')}"
    ].join("")],
    shell: false,
    epoch: `migration-${Date.now()}`,
    runId: `migration-${process.pid}`,
    nonce: `migration-nonce-${Date.now()}`,
    backend: "linux-cgroup"
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
  const source = [
    `import { createLinuxCgroupBackend } from ${JSON.stringify(backendUrl)};`,
    `const backend=createLinuxCgroupBackend();`,
    `await backend.probe();`,
    `await backend.launch(${JSON.stringify({
      command: process.execPath,
      args: ["-e", ""],
      shell: false,
      backend: "linux-cgroup",
      ...deathIdentity
    })});`,
    "process.send('launched');"
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
  coordinator.disconnect();
  await new Promise((resolve) => coordinator.once("exit", resolve));
  const deadline = Date.now() + 5000;
  let deathState;
  while (Date.now() < deadline) {
    const audit = await client.request(request("probe", {
      epoch: `audit-${Date.now()}`,
      runId: `audit-${process.pid}`,
      nonce: `audit-nonce-${Date.now()}`
    }));
    deathState = audit.registry?.find((entry) => entry.runId === deathIdentity.runId);
    if (deathState?.state === "drained") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(deathState?.state, "drained");
});
