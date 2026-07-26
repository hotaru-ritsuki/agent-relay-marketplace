import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { EventEmitter } from "node:events";

import {
  MAX_FRAME_BYTES,
  SupervisorInfrastructureError,
  createProcessSupervisor,
  runSynchronous
} from "./process-supervisor/index.mjs";

function fakeBackend({
  mode = "cooperative",
  cleanup = { level: "registered-drained" },
  root = {
    status: 0,
    signal: null,
    stdout: Buffer.from("ok"),
    stderr: Buffer.alloc(0)
  },
  launch,
  shutdown
} = {}) {
  return {
    async probe() {
      return {
        available: true,
        capabilities: {
          platform: "test",
          backend: "fake",
          mode,
          containment: mode === "host-strict" ? "kernel" : "cooperative",
          cleanupProof: mode === "host-strict"
            ? "kernel-drained"
            : "registered-drained",
          supportsDetachedDescendants: true
        }
      };
    },
    async launch(spec, context) {
      if (launch) return launch(spec, context);
      return context.createFakeLaunch({ spec, root, cleanup });
    },
    async shutdown() {
      if (shutdown) return shutdown();
      return { stopped: true };
    }
  };
}

function createFakeSupervisor(backendOptions = {}, supervisorOptions = {}) {
  const root = backendOptions.root ?? {
    status: 0,
    signal: null,
    stdout: Buffer.from("ok"),
    stderr: Buffer.alloc(0)
  };
  const cleanup = backendOptions.cleanup ?? { level: "registered-drained" };
  return createProcessSupervisor({
    platform: "test",
    backendFactories: [() => fakeBackend(backendOptions)],
    syncBridge(request) {
      return {
        capabilities: {
          platform: "test",
          backend: "fake",
          mode: "cooperative",
          containment: "cooperative",
          cleanupProof: "registered-drained",
          supportsDetachedDescendants: true
        },
        root: { backend: "fake", ...root },
        cleanup: { backend: "fake", ...cleanup }
      };
    },
    ...supervisorOptions
  });
}

test("host-strict rejects a cooperative backend", async () => {
  const supervisor = createFakeSupervisor({}, {
    mode: "host-strict",
    minimumGuarantee: "host-strict"
  });

  await assert.rejects(
    supervisor.capabilities,
    (error) => error instanceof SupervisorInfrastructureError &&
      error.code === "CAPABILITY_UNAVAILABLE"
  );
});

test("host-strict synchronous preflight refuses before invoking the bridge", () => {
  let launches = 0;
  const supervisor = createProcessSupervisor({
    platform: "test",
    mode: "host-strict",
    minimumGuarantee: "host-strict",
    backendFactories: [() => fakeBackend({ mode: "host-strict" })],
    syncBridge() {
      launches += 1;
      throw new Error("must not launch");
    },
    syncBackendSelection: { type: "child-process" }
  });

  assert.throws(
    () => supervisor.run({ command: "tool", args: [] }),
    (error) => error.code === "CAPABILITY_UNAVAILABLE"
  );
  assert.equal(launches, 0);
});

test("run is synchronous and returns a nonzero target status without throwing", () => {
  const supervisor = createFakeSupervisor({
    root: {
      status: 17,
      signal: null,
      stdout: Buffer.from("out"),
      stderr: Buffer.from("err")
    }
  });

  const result = supervisor.run({ command: "tool", args: [] });

  assert.equal(result instanceof Promise, false);
  assert.equal(result.status, 17);
  assert.equal(result.stdout.toString(), "out");
  assert.equal(result.stderr.toString(), "err");
});

test("run throws when cleanup proof is missing", () => {
  const supervisor = createFakeSupervisor({ cleanup: { level: "missing" } });

  assert.throws(
    () => supervisor.run({ command: "tool", args: [] }),
    (error) => error instanceof SupervisorInfrastructureError &&
      error.code === "CLEANUP_UNPROVEN" &&
      error.result?.status === 0
  );
});

test("spawn completion rejects on proof failure and attaches the terminal result", async () => {
  const supervisor = createFakeSupervisor({ cleanup: { level: "missing" } });
  const child = await supervisor.spawnTracked({
    command: "tool",
    args: [],
    stdio: ["ignore", "pipe", "pipe"]
  });

  await assert.rejects(
    child.completion,
    (error) => error.code === "CLEANUP_UNPROVEN" &&
      error.result?.supervisor.cleanup.level === "missing"
  );
});

test("exit precedes completion settlement and close follows it", async () => {
  const supervisor = createFakeSupervisor();
  const child = await supervisor.spawnTracked({ command: "tool", args: [] });
  const events = [];
  child.on("exit", () => events.push("exit"));
  child.completion.finally(() => events.push("completion"));
  child.on("close", () => events.push("close"));

  await child.completion;
  await new Promise((resolve) => child.once("close", resolve));

  assert.deepEqual(events, ["exit", "completion", "close"]);
});

test("kill is idempotent and records requested versus observed signal", async () => {
  const supervisor = createFakeSupervisor({
    root: {
      status: null,
      signal: "SIGKILL",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0)
    }
  });
  const child = await supervisor.spawnTracked({ command: "tool", args: [] });

  assert.equal(child.kill("SIGTERM"), true);
  assert.equal(child.kill("SIGTERM"), false);
  const result = await child.completion;

  assert.equal(result.supervisor.requestedSignal, "SIGTERM");
  assert.equal(result.supervisor.observedSignal, "SIGKILL");
});

test("concurrent cleanupAll calls share one operation", async () => {
  let cleanupCalls = 0;
  const supervisor = createFakeSupervisor({
    launch(spec, context) {
      return context.createFakeLaunch({
        spec,
        root: { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
        cleanup: async () => {
          cleanupCalls += 1;
          await new Promise((resolve) => setImmediate(resolve));
          return { level: "registered-drained" };
        }
      });
    }
  });
  await supervisor.spawnTracked({ command: "tool", args: [] });

  const first = supervisor.cleanupAll();
  const second = supervisor.cleanupAll();
  assert.equal(first, second);
  await first;
  assert.equal(cleanupCalls, 1);
});

test("shutdown refuses later launches", async () => {
  const supervisor = createFakeSupervisor();
  await supervisor.shutdown();

  await assert.rejects(
    supervisor.spawnTracked({ command: "tool", args: [] }),
    (error) => error.code === "SUPERVISOR_SHUTDOWN"
  );
});

test("ignored operation failure is rethrown by assertHealthy", async () => {
  const supervisor = createFakeSupervisor({ cleanup: { level: "missing" } });
  assert.throws(() => supervisor.run({ command: "tool", args: [] }));

  assert.throws(
    () => supervisor.assertHealthy(),
    (error) => error.code === "CLEANUP_UNPROVEN"
  );
});

test("cleanupAll validates active lease proof before returning", async () => {
  const supervisor = createFakeSupervisor({
    cleanup: { level: "missing" },
    root: new Promise(() => {})
  });
  const child = await supervisor.spawnTracked({ command: "tool", args: [] });
  child.completion.catch(() => {});

  await assert.rejects(
    supervisor.cleanupAll(),
    (error) => error.code === "CLEANUP_UNPROVEN"
  );
  assert.throws(
    () => supervisor.assertHealthy(),
    (error) => error.code === "CLEANUP_UNPROVEN"
  );
});

test("shutdown rejects invalid backend stop evidence", async () => {
  const supervisor = createFakeSupervisor({}, {
    backendFactories: [() => fakeBackend({
      shutdown: async () => ({ stopped: false })
    })]
  });

  await assert.rejects(
    supervisor.shutdown(),
    (error) => error.code === "SHUTDOWN_UNPROVEN"
  );
});

test("root errors reject completion with a structured result and latch", async () => {
  const spawnError = Object.assign(new Error("missing executable"), {
    code: "ENOENT"
  });
  const supervisor = createFakeSupervisor({
    root: {
      status: null,
      signal: null,
      stdout: undefined,
      stderr: undefined,
      error: spawnError
    }
  });
  const child = await supervisor.spawnTracked({ command: "missing", args: [] });

  await assert.rejects(
    child.completion,
    (error) => error.code === "ROOT_PROCESS_ERROR" &&
      error.result?.error === spawnError
  );
  assert.throws(
    () => supervisor.assertHealthy(),
    (error) => error.code === "ROOT_PROCESS_ERROR"
  );
});

test("spawnTracked always returns a coordinator-owned facade", async () => {
  const rawChild = new EventEmitter();
  rawChild.kill = () => true;
  const supervisor = createFakeSupervisor({
    launch(spec, context) {
      return {
        ...context.createFakeLaunch({
          spec,
          root: {
            status: 3,
            signal: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0)
          },
          cleanup: { level: "registered-drained" }
        }),
        child: rawChild
      };
    }
  });
  const child = await supervisor.spawnTracked({ command: "tool", args: [] });
  const events = [];
  child.on("exit", () => events.push("exit"));
  child.completion.finally(() => events.push("completion"));
  child.on("close", () => events.push("close"));

  assert.notEqual(child, rawChild);
  await child.completion;
  await new Promise((resolve) => child.once("close", resolve));
  assert.deepEqual(events, ["exit", "completion", "close"]);
});

test("backend identity mismatch rejects proof and recorded-state correlation", async () => {
  const supervisor = createFakeSupervisor({
    cleanup: { level: "registered-drained", backend: "impostor" }
  });

  assert.throws(
    () => supervisor.run({ command: "tool", args: [] }),
    (error) => error.code === "BACKEND_IDENTITY_MISMATCH"
  );
});

test("recorded state with a mismatched backend never correlates to a live lease", async () => {
  let recorded;
  const supervisor = createProcessSupervisor({
    platform: "test",
    backendFactories: [() => fakeBackend({
      root: new Promise(() => {}),
      launch(spec, context) {
        recorded = {
          epoch: spec.epoch,
          runId: spec.runId,
          nonce: spec.nonce,
          backend: "impostor",
          pid: 1234
        };
        return context.createFakeLaunch({
          spec,
          root: new Promise(() => {}),
          cleanup: { level: "registered-drained" }
        });
      }
    })],
    discoverRecordedProcesses: async () => recorded ? [recorded] : [],
    syncBridge() {
      throw new Error("not used");
    }
  });
  const child = await supervisor.spawnTracked({ command: "tool", args: [] });
  child.completion.catch(() => {});

  await assert.rejects(
    supervisor.cleanupAll(),
    (error) => error.code === "UNREGISTERED_RECORDED_PROCESS"
  );
});

test("capability inconsistency latches selection failure", async () => {
  const supervisor = createFakeSupervisor({}, {
    backendFactories: [() => ({
      ...fakeBackend(),
      async probe() {
        return {
          available: true,
          capabilities: {
            platform: "wrong",
            backend: "fake",
            mode: "cooperative",
            containment: "cooperative",
            cleanupProof: "registered-drained",
            supportsDetachedDescendants: true
          }
        };
      }
    })]
  });

  await assert.rejects(
    supervisor.capabilities,
    (error) => error.code === "CAPABILITY_INVALID"
  );
  assert.throws(
    () => supervisor.assertHealthy(),
    (error) => error.code === "CAPABILITY_INVALID"
  );
});

test("probe failures latch the first infrastructure error", async () => {
  const supervisor = createFakeSupervisor({}, {
    backendFactories: [() => ({
      async probe() {
        throw new Error("probe transport lost");
      }
    })]
  });
  await assert.rejects(
    supervisor.capabilities,
    (error) => error.code === "CAPABILITY_PROBE_FAILED"
  );
  assert.throws(
    () => supervisor.assertHealthy(),
    (error) => error.code === "CAPABILITY_PROBE_FAILED"
  );
});

test("public run and spawn reject shell-enabled specifications", async () => {
  const supervisor = createFakeSupervisor();
  assert.throws(
    () => supervisor.run({ command: "tool", args: [], shell: true }),
    (error) => error.code === "SHELL_UNSAFE"
  );
  await assert.rejects(
    supervisor.spawnTracked({ command: "tool", args: [], shell: true }),
    (error) => error.code === "SHELL_UNSAFE"
  );
});

test("coordinator centrally rejects malformed root and proof payloads", async () => {
  const malformedRoot = createFakeSupervisor({
    root: {
      status: "zero",
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0)
    }
  });
  await assert.rejects(
    (await malformedRoot.spawnTracked({ command: "tool", args: [] })).completion,
    (error) => error.code === "PROTOCOL_INVALID_MESSAGE"
  );

  const oversizedOutput = createFakeSupervisor({
    root: {
      status: 0,
      signal: null,
      stdout: Buffer.alloc(MAX_FRAME_BYTES + 1),
      stderr: Buffer.alloc(0)
    }
  });
  assert.throws(
    () => oversizedOutput.run({ command: "tool", args: [] }),
    (error) => error.code === "PROTOCOL_FRAME_TOO_LARGE"
  );
});

test("bounded synchronous worker removes secret files and exits", () => {
  const before = new Set(
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("process-supervisor-"))
  );
  const result = runSynchronous({
    spec: {
      command: process.execPath,
      args: ["-e", "process.stdout.write('worker-ok')"],
      shell: false,
      encoding: "utf8"
    },
    backendSelection: { type: "child-process" },
    platform: process.platform,
    mode: "auto",
    minimumGuarantee: "cooperative",
    epoch: "epoch",
    runId: "run",
    nonce: "nonce"
  });
  assert.equal(result.root.stdout, "worker-ok");

  assert.throws(
    () => runSynchronous({
      spec: {
        command: process.execPath,
        args: [],
        shell: false,
        env: { SECRET: "x".repeat(MAX_FRAME_BYTES) }
      },
      backendSelection: { type: "child-process" },
      platform: process.platform,
      mode: "auto",
      minimumGuarantee: "cooperative",
      epoch: "epoch",
      runId: "oversized",
      nonce: "nonce"
    }),
    (error) => error.code === "PROTOCOL_FRAME_TOO_LARGE"
  );

  const after = fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("process-supervisor-"));
  assert.deepEqual(after.filter((name) => !before.has(name)), []);
});

test("forced synchronous Worker termination settles before secret deletion", () => {
  const before = new Set(
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("process-supervisor-"))
  );
  const lifecycle = new Int32Array(new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * 3
  ));

  assert.throws(
    () => runSynchronous({
      spec: {
        command: "unused",
        args: [],
        env: { SECRET: "forced-termination-secret" },
        shell: false
      },
      backendSelection: { type: "child-process" },
      platform: process.platform,
      mode: "auto",
      minimumGuarantee: "cooperative",
      epoch: "epoch",
      runId: "stuck",
      nonce: "nonce"
    }, {
      operationTimeout: 50,
      executorUrl: new URL("./process-supervisor/stuck-worker.mjs", import.meta.url),
      lifecycleBuffer: lifecycle.buffer
    }),
    (error) => error.code === "SYNC_BRIDGE_FAILED"
  );

  const after = fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith("process-supervisor-"));
  assert.deepEqual(after.filter((name) => !before.has(name)), []);
  assert.deepEqual(
    [...lifecycle.subarray(0, 2)],
    [1, 2],
    "executor termination must settle before secret files are removed"
  );
});

test("synchronous worker decodes Buffer and typed-array input byte-exactly", () => {
  for (const [name, input] of [
    ["Buffer", Buffer.from([0, 1, 127, 128, 255])],
    ["Uint8Array", new Uint8Array([255, 128, 127, 1, 0])]
  ]) {
    const result = runSynchronous({
      spec: {
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.on('data',b=>process.stdout.write(b.toString('hex')))"
        ],
        input,
        shell: false,
        encoding: "utf8"
      },
      backendSelection: { type: "child-process" },
      platform: process.platform,
      mode: "auto",
      minimumGuarantee: "cooperative",
      epoch: "epoch",
      runId: `input-${name}`,
      nonce: "nonce"
    });

    assert.equal(result.root.stdout, Buffer.from(input).toString("hex"), name);
  }
});

test("synchronous worker preserves null output for inherited and ignored stdio", () => {
  for (const stdio of ["inherit", "ignore"]) {
    const supervisor = createProcessSupervisor({
      platform: process.platform,
      backendFactories: [() => ({
        async probe() {
          return {
            available: true,
            capabilities: {
              platform: process.platform,
              backend: "child-process",
              mode: "cooperative",
              containment: "cooperative",
              cleanupProof: "registered-drained",
              supportsDetachedDescendants: false
            }
          };
        }
      })],
      syncBackendSelection: { type: "child-process" }
    });

    const result = supervisor.run({
      command: process.execPath,
      args: ["-e", ""],
      shell: false,
      stdio
    });

    assert.equal(result.stdout, null, stdio);
    assert.equal(result.stderr, null, stdio);
  }
});

test("oversized maxBuffer is rejected before invoking the synchronous bridge", () => {
  let launches = 0;
  const supervisor = createFakeSupervisor({}, {
    syncBridge() {
      launches += 1;
      throw new Error("must not launch");
    }
  });

  assert.throws(
    () => supervisor.run({
      command: "tool",
      args: [],
      maxBuffer: MAX_FRAME_BYTES + 1
    }),
    (error) => error.code === "INVALID_LAUNCH_SPEC"
  );
  assert.equal(launches, 0);
});

test("parent teardown revalidates every synchronous terminal proof", async () => {
  const proof = { backend: "fake", level: "registered-drained" };
  const supervisor = createProcessSupervisor({
    platform: "test",
    backendFactories: [() => fakeBackend()],
    syncBridge() {
      return {
        capabilities: {
          platform: "test",
          backend: "fake",
          mode: "cooperative",
          containment: "cooperative",
          cleanupProof: "registered-drained",
          supportsDetachedDescendants: true
        },
        root: {
          backend: "fake",
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0)
        },
        cleanup: proof
      };
    }
  });
  assert.equal(supervisor.run({ command: "tool", args: [] }).status, 0);
  proof.level = "missing";

  await assert.rejects(
    supervisor.cleanupAll(),
    (error) => error.code === "CLEANUP_UNPROVEN"
  );
});

test("undocumented runAsync is not exposed", () => {
  const supervisor = createFakeSupervisor();
  assert.equal("runAsync" in supervisor, false);
});

test("protocol messages over the byte cap poison the epoch", async () => {
  const supervisor = createFakeSupervisor({
    launch(spec, context) {
      context.assertFrame(Buffer.alloc(MAX_FRAME_BYTES + 1));
      return context.createFakeLaunch({
        spec,
        root: { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
        cleanup: { level: "registered-drained" }
      });
    }
  });

  await assert.rejects(
    supervisor.spawnTracked({ command: "tool", args: [] }),
    (error) => error.code === "PROTOCOL_FRAME_TOO_LARGE"
  );
  assert.throws(
    () => supervisor.assertHealthy(),
    (error) => error.code === "PROTOCOL_FRAME_TOO_LARGE"
  );
});

test("unleased recorded state fails closed without backend PID termination", async () => {
  let terminatePidCalls = 0;
  const supervisor = createFakeSupervisor({
    launch(spec, context) {
      return context.createFakeLaunch({
        spec,
        root: { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
        cleanup: { level: "registered-drained" },
        terminateRecordedPid() {
          terminatePidCalls += 1;
        }
      });
    }
  }, {
    discoverRecordedProcesses: async () => [{
      epoch: "old-epoch",
      runId: "old-run",
      nonce: "old-nonce",
      pid: 1234
    }]
  });

  await assert.rejects(
    supervisor.cleanupAll(),
    (error) => error.code === "UNREGISTERED_RECORDED_PROCESS"
  );
  assert.equal(terminatePidCalls, 0);
});

test("helpers expose explicit health and suite teardown wrappers", async () => {
  const helpers = await import("./helpers.mjs");
  assert.equal(typeof helpers.run, "function");
  assert.equal(typeof helpers.spawnTracked, "function");
  assert.equal(typeof helpers.cleanupTrackedChildren, "function");
  assert.equal(typeof helpers.assertSupervisorHealthy, "function");
  assert.equal(typeof helpers.installSupervisorTeardown, "function");
  const normalizedShell = helpers.run(
    process.execPath,
    ["-e", ""],
    { shell: true }
  );
  assert.equal(normalizedShell.status, 0);
  assert.equal(normalizedShell.supervisor.backend, "child-process");

  let teardown;
  helpers.installSupervisorTeardown((callback) => {
    teardown = callback;
  });
  assert.equal(typeof teardown, "function");
  await teardown();
});
