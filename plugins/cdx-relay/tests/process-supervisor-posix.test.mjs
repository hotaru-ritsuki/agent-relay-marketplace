import assert from "node:assert/strict";
import test from "node:test";

import {
  createPosixProcessGroupBackend,
  decodeSupervisorToken
} from "./process-supervisor/backends/posix-process-group.mjs";
import { createMacosBackend } from "./process-supervisor/backends/macos.mjs";
import {
  inheritSupervisorEnvironment,
  registerControlledDescendant
} from "./process-supervisor/coordinator.mjs";

const identity = {
  epoch: "epoch-1",
  runId: "run-1",
  nonce: "nonce-1",
  backend: "posix-cooperative"
};

function controlledBackend(overrides = {}) {
  const calls = [];
  let registrationHandlers;
  const child = {
    pid: 4312,
    stdout: null,
    stderr: null,
    once() {},
    kill() {
      return true;
    }
  };
  const backend = createPosixProcessGroupBackend({
    platform: "linux",
    shimPath: "/trusted/launch-shim.mjs",
    spawn(command, args, options) {
      calls.push({ type: "spawn", command, args, options });
      return child;
    },
    async createRegistrationChannel(handlers) {
      registrationHandlers = handlers;
      return {
        endpoint: "unix:/tmp/cdx-supervisor.sock",
        async close() {}
      };
    },
    async inspectProcess(pid) {
      return { pid, startTime: "100", executable: "/usr/bin/node" };
    },
    killGroup(pid, signal) {
      calls.push({ type: "kill", pid, signal });
    },
    async waitForDrain() {},
    ...overrides
  });
  return {
    backend,
    calls,
    child,
    handlers: () => registrationHandlers
  };
}

test("launch uses the trusted shim as a detached process-group leader and passes the exact target", async () => {
  const fixture = controlledBackend();
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/printf",
    args: ["%s", "hello world"],
    cwd: "/work",
    env: { PATH: "/usr/bin" },
    shell: false
  });

  const call = fixture.calls[0];
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args.slice(0, 1), ["/trusted/launch-shim.mjs"]);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.shell, false);
  assert.deepEqual(
    JSON.parse(Buffer.from(call.args[1], "base64url").toString("utf8")),
    { command: "/usr/bin/printf", args: ["%s", "hello world"] }
  );
  assert.equal(launched.pid, 4312);
});

test("launch token binds version, lease identity, nonce, and registration endpoint", async () => {
  const fixture = controlledBackend();
  await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });

  assert.deepEqual(
    decodeSupervisorToken(
      fixture.calls[0].options.env.CDX_RELAY_SUPERVISOR_TOKEN
    ),
    {
      version: 1,
      epoch: "epoch-1",
      runId: "run-1",
      nonce: "nonce-1",
      endpoint: "unix:/tmp/cdx-supervisor.sock"
    }
  );
});

test("root completion does not wait for descendant-held stdout to close", async () => {
  const fixture = controlledBackend();
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });
  const descendantStdoutClose = new Promise(() => {});
  fixture.handlers().root({
    type: "root",
    version: 1,
    ...identity,
    status: 0,
    signal: null
  });

  assert.deepEqual(await Promise.race([
    launched.root,
    descendantStdoutClose
  ]), {
    backend: "posix-cooperative",
    status: 0,
    signal: null,
    stdout: undefined,
    stderr: undefined,
    error: undefined
  });
});

test("registered descendants are revalidated before fallback termination", async () => {
  const inspections = [];
  const individualKills = [];
  const fixture = controlledBackend({
    async inspectProcess(pid) {
      inspections.push(pid);
      return { pid, startTime: pid === 4312 ? "100" : "200", executable: "/usr/bin/node" };
    },
    killProcess(pid, signal) {
      individualKills.push({ pid, signal });
    },
    async waitForDrain() {}
  });
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });
  await fixture.handlers().hello({
    type: "hello",
    version: 1,
    ...identity,
    pid: 4500,
    parentPid: 4312
  });
  await launched.cleanup();

  assert.deepEqual(inspections, [4312, 4500, 4312, 4312, 4500]);
  assert.deepEqual(individualKills, [{ pid: 4500, signal: "SIGKILL" }]);
});

test("cleanup sends group SIGTERM, waits a bounded grace, then sends group SIGKILL", async () => {
  const waits = [];
  const fixture = controlledBackend({
    async waitForDrain({ deadline, phase }) {
      waits.push({ deadline, phase });
      return false;
    },
    now: (() => {
      let value = 1000;
      return () => value;
    })(),
    graceMs: 25,
    forceMs: 10
  });
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });
  const proof = await launched.cleanup();

  assert.deepEqual(
    fixture.calls.filter((call) => call.type === "kill"),
    [
      { type: "kill", pid: 4312, signal: "SIGTERM" },
      { type: "kill", pid: 4312, signal: "SIGKILL" }
    ]
  );
  assert.deepEqual(waits, [
    { deadline: 1025, phase: "grace" },
    { deadline: 1010, phase: "force" }
  ]);
  assert.deepEqual(proof, {
    backend: "posix-cooperative",
    level: "registered-drained",
    registered: 0
  });
});

test("identity mismatch fails closed before individual fallback termination", async () => {
  let descendantInspections = 0;
  const fixture = controlledBackend({
    async inspectProcess(pid) {
      if (pid === 4312) {
        return { pid, startTime: "100", executable: "/usr/bin/node" };
      }
      descendantInspections += 1;
      return {
        pid,
        startTime: descendantInspections === 1 ? "200" : "reused",
        executable: "/usr/bin/node"
      };
    },
    async waitForDrain() {
      return false;
    }
  });
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });
  await fixture.handlers().hello({
    type: "hello",
    version: 1,
    ...identity,
    pid: 4500,
    parentPid: 4312,
  });

  await assert.rejects(
    launched.cleanup(),
    (error) => error.code === "PROCESS_IDENTITY_MISMATCH"
  );
});

test("lost registration channel rejects cleanup proof with PROTOCOL_LOST", async () => {
  const fixture = controlledBackend();
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });
  fixture.handlers().lost(new Error("socket closed"));

  await assert.rejects(
    launched.cleanup(),
    (error) => error.code === "PROTOCOL_LOST"
  );
});

test("unregistered recorded state rejects with UNREGISTERED_RECORDED_PROCESS", async () => {
  const fixture = controlledBackend({
    async discoverRecordedProcesses() {
      return [{ ...identity, pid: 9999 }];
    }
  });
  await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });

  await assert.rejects(
    fixture.backend.cleanupAll(),
    (error) => error.code === "UNREGISTERED_RECORDED_PROCESS"
  );
});

test("Linux cooperative capabilities never claim kernel cleanup", async () => {
  const fixture = controlledBackend();
  const probe = await fixture.backend.probe();

  assert.deepEqual(probe, {
    available: true,
    capabilities: {
      platform: "linux",
      backend: "posix-cooperative",
      mode: "cooperative",
      containment: "cooperative",
      cleanupProof: "registered-drained",
      supportsDetachedDescendants: false
    }
  });
});

test("macOS cooperative policy reports registered-drained capability", async () => {
  const backend = createMacosBackend({
    createPosixBackend: () => controlledBackend().backend
  });

  assert.deepEqual(await backend.probe(), {
    available: true,
    capabilities: {
      platform: "darwin",
      backend: "posix-cooperative",
      mode: "cooperative",
      containment: "cooperative",
      cleanupProof: "registered-drained",
      supportsDetachedDescendants: false
    }
  });
});

test("macOS rejects host-strict locally without environment disposal claims", async () => {
  const backend = createMacosBackend({
    mode: "host-strict",
    env: { CDX_RELAY_EXTERNAL_DISPOSAL: "true" },
    createPosixBackend: () => controlledBackend().backend
  });

  await assert.rejects(
    backend.probe(),
    (error) => error.code === "CAPABILITY_UNAVAILABLE"
  );
});

test("controlled descendant registers its lease identity before release", async () => {
  const token = Buffer.from(JSON.stringify({
    version: 1,
    epoch: "epoch-2",
    runId: "run-2",
    nonce: "nonce-2",
    endpoint: "unix:/tmp/controlled.sock"
  })).toString("base64url");
  const messages = [];
  const registration = await registerControlledDescendant({
    env: { CDX_RELAY_SUPERVISOR_TOKEN: token },
    pid: 5100,
    parentPid: 5000,
    async openRegistration(actualToken, hello) {
      messages.push({ actualToken, hello });
      return { close() {} };
    }
  });

  assert.equal(registration.registered, true);
  assert.deepEqual(messages, [{
    actualToken: {
      version: 1,
      epoch: "epoch-2",
      runId: "run-2",
      nonce: "nonce-2",
      endpoint: "unix:/tmp/controlled.sock"
    },
    hello: {
      type: "hello",
      version: 1,
      epoch: "epoch-2",
      runId: "run-2",
      nonce: "nonce-2",
      backend: "posix-cooperative",
      pid: 5100,
      parentPid: 5000
    }
  }]);
});

test("controlled descendant registration is a no-op without a token", async () => {
  let opened = false;
  const registration = await registerControlledDescendant({
    env: {},
    async openRegistration() {
      opened = true;
    }
  });

  assert.deepEqual(registration, { registered: false });
  assert.equal(opened, false);
});

test("controlled child spawn environment preserves the supervisor token", () => {
  const env = inheritSupervisorEnvironment({
    PATH: "/usr/bin",
    CDX_RELAY_SUPERVISOR_TOKEN: "trusted-token"
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    CDX_RELAY_SUPERVISOR_TOKEN: "trusted-token"
  });
});
