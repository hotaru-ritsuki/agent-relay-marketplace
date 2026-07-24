import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_FRAME_BYTES,
  SupervisorInfrastructureError,
  createProcessSupervisor
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
          cleanupProof: cleanup.level,
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
  return createProcessSupervisor({
    platform: "test",
    backendFactories: [() => fakeBackend(backendOptions)],
    syncBridge: (runAsync, spec) => runAsync(spec),
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

test("run returns a nonzero target status without throwing", async () => {
  const supervisor = createFakeSupervisor({
    root: {
      status: 17,
      signal: null,
      stdout: Buffer.from("out"),
      stderr: Buffer.from("err")
    }
  });

  const result = await supervisor.run({ command: "tool", args: [] });

  assert.equal(result.status, 17);
  assert.equal(result.stdout.toString(), "out");
  assert.equal(result.stderr.toString(), "err");
});

test("run throws when cleanup proof is missing", async () => {
  const supervisor = createFakeSupervisor({ cleanup: { level: "missing" } });

  await assert.rejects(
    supervisor.run({ command: "tool", args: [] }),
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
  await assert.rejects(supervisor.run({ command: "tool", args: [] }));

  assert.throws(
    () => supervisor.assertHealthy(),
    (error) => error.code === "CLEANUP_UNPROVEN"
  );
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
    supervisor.run({ command: "tool", args: [] }),
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

  let teardown;
  helpers.installSupervisorTeardown((callback) => {
    teardown = callback;
  });
  assert.equal(typeof teardown, "function");
  await teardown();
});
