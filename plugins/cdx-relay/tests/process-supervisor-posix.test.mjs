import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createNetRegistrationChannel,
  createPosixProcessGroupBackend,
  decodeSupervisorToken
} from "./process-supervisor/backends/posix-process-group.mjs";
import { createMacosBackend } from "./process-supervisor/backends/macos.mjs";
import {
  createProcessSupervisor,
  inheritSupervisorEnvironment,
  registerControlledDescendant
} from "./process-supervisor/coordinator.mjs";
import { spawnBrokerProcess } from "../scripts/lib/broker-lifecycle.mjs";
import { spawnBackgroundProcess } from "../scripts/lib/process.mjs";

const identity = {
  epoch: "epoch-1",
  runId: "run-1",
  nonce: "nonce-1",
  backend: "posix-cooperative"
};
const launchShimPath = fileURLToPath(
  new URL("./process-supervisor/launch-shim.mjs", import.meta.url)
);

async function listenOnTestPipe(onMessage, onClose = () => {}) {
  const pipe = `\\\\.\\pipe\\cdx-posix-${process.pid}-${Date.now()}-${Math.random()}`;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        onMessage(message, socket);
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      onClose();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });
  return {
    endpoint: `unix:${pipe}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

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
        async send(pid, frame) {
          calls.push({ type: "control", pid, frame });
        },
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

function heldRootBackend(platform) {
  const processes = new Map([
    [4312, {
      pid: 4312,
      processGroupId: 4312,
      startTime: "root-start",
      executable: "/usr/bin/node"
    }],
    [4400, {
      pid: 4400,
      processGroupId: 4312,
      startTime: "command-start",
      executable: "/usr/bin/node"
    }]
  ]);
  const groupSignals = [];
  let registrationHandlers;
  let rootCredential;
  const child = {
    pid: 4312,
    stdout: null,
    stderr: null,
    once() {},
    kill() {
      return true;
    }
  };
  const cooperative = createPosixProcessGroupBackend({
    platform,
    spawn(_command, _args, options) {
      rootCredential = options.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL;
      return child;
    },
    async createRegistrationChannel(handlers) {
      registrationHandlers = handlers;
      return {
        endpoint: "unix:/tmp/cdx-held-root.sock",
        async close() {}
      };
    },
    async inspectProcess(pid) {
      return processes.get(pid) ?? null;
    },
    killGroup(pid, signal) {
      groupSignals.push({ pid, signal });
      for (const [candidatePid, candidate] of processes) {
        if (candidate.processGroupId === pid) {
          processes.delete(candidatePid);
        }
      }
    },
    async waitForDrain() {
      await registrationHandlers.closed(4400);
      await registrationHandlers.closed(4500);
      return processes.size === 0;
    },
    graceMs: 1,
    forceMs: 1
  });
  const backend = platform === "darwin"
    ? createMacosBackend({ createPosixBackend: () => cooperative })
    : cooperative;
  return {
    backend,
    groupSignals,
    handlers: () => registrationHandlers,
    processes,
    rootCredential: () => rootCredential,
    registerBackground(pid = 4500) {
      let detached;
      spawnBackgroundProcess(process.execPath, ["background.mjs"], {
        env: { CDX_RELAY_SUPERVISOR_TOKEN: "active-token" }
      }, {
        spawn(_command, _args, options) {
          detached = options.detached;
          return { unref() {} };
        }
      });
      processes.set(pid, {
        pid,
        processGroupId: detached ? pid : 4312,
        startTime: "background-start",
        executable: "/usr/bin/node"
      });
      return registrationHandlers.hello({
        type: "hello",
        version: 1,
        ...identity,
        pid,
        parentPid: 4400
      });
    }
  };
}

async function launchHeldRoot(fixture) {
  const launched = await fixture.backend.launch({
    ...identity,
    command: process.execPath,
    args: ["-e", ""],
    env: { CDX_RELAY_SUPERVISOR_TOKEN: "active-token" },
    shell: false
  });
  await fixture.handlers().hello({
    type: "hello",
    version: 1,
    ...identity,
    pid: 4400,
    parentPid: 4312
  });
  await fixture.registerBackground();
  return launched;
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
  assert.match(
    fixture.calls[0].options.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL,
    /^[A-Za-z0-9_-]{43}$/
  );
  assert.equal(
    JSON.stringify(decodeSupervisorToken(
      fixture.calls[0].options.env.CDX_RELAY_SUPERVISOR_TOKEN
    )).includes(fixture.calls[0].options.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL),
    false
  );
});

test("spawn throw closes the provisional registration channel without publishing ownership", async () => {
  let closes = 0;
  const backend = createPosixProcessGroupBackend({
    platform: "linux",
    spawn() {
      throw Object.assign(new Error("spawn failed"), { code: "EACCES" });
    },
    async createRegistrationChannel() {
      return {
        endpoint: "unix:/tmp/cdx-provisional-spawn.sock",
        async close() {
          closes += 1;
        }
      };
    }
  });

  await assert.rejects(
    backend.launch({
      ...identity,
      command: "/missing",
      args: [],
      env: {},
      shell: false
    }),
    { code: "EACCES" }
  );
  assert.equal(closes, 1);
  assert.deepEqual(await backend.cleanupAll(), {
    backend: "posix-cooperative",
    level: "registered-drained",
    registered: 0
  });
});

test("post-spawn identity failure closes the blocked shim channel and awaits its exit", async () => {
  let closes = 0;
  let exited = false;
  const child = new EventEmitter();
  child.pid = 4312;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const backend = createPosixProcessGroupBackend({
    platform: "linux",
    spawn() {
      return child;
    },
    async createRegistrationChannel() {
      return {
        endpoint: "unix:/tmp/cdx-provisional-identity.sock",
        async close() {
          closes += 1;
          queueMicrotask(() => {
            exited = true;
            child.emit("exit", 1, null);
          });
        }
      };
    },
    async inspectProcess() {
      return null;
    },
    handshakeMs: 50
  });

  await assert.rejects(
    backend.launch({
      ...identity,
      command: "/usr/bin/true",
      args: [],
      env: {},
      shell: false
    }),
    (error) => error.code === "PROCESS_IDENTITY_UNAVAILABLE"
  );
  assert.equal(closes, 1);
  assert.equal(exited, true);
});

test("authenticated hello identity drains a released group when parent inspection later fails", async () => {
  let handlers;
  let closes = 0;
  let released = false;
  let alive = true;
  let resolveHello;
  const helloComplete = new Promise((resolve) => {
    resolveHello = resolve;
  });
  const signals = [];
  const child = new EventEmitter();
  child.pid = 4312;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let inspection = 0;
  const authenticatedIdentity = {
    pid: 4312,
    processGroupId: 4312,
    startTime: "authenticated-start",
    executable: "/usr/bin/node"
  };
  const backend = createPosixProcessGroupBackend({
    platform: "linux",
    spawn(_command, _args, options) {
      queueMicrotask(async () => {
        await handlers.hello({
          type: "hello",
          version: 1,
          ...identity,
          pid: 4312,
          parentPid: 4000,
          rootCredential: options.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL
        });
        released = true;
        resolveHello();
      });
      return child;
    },
    async createRegistrationChannel(nextHandlers) {
      handlers = nextHandlers;
      return {
        endpoint: "unix:/tmp/cdx-hello-race.sock",
        async close() {
          closes += 1;
        }
      };
    },
    async inspectProcess() {
      inspection += 1;
      if (inspection === 1) {
        await helloComplete;
        return null;
      }
      return alive ? authenticatedIdentity : null;
    },
    killGroup(pid, signal) {
      assert.equal(released, true, "the authenticated hello was released");
      signals.push({ pid, signal });
      alive = false;
    },
    async waitForDrain() {
      return true;
    },
    handshakeMs: 25
  });

  await assert.rejects(
    backend.launch({
      ...identity,
      command: "/usr/bin/true",
      args: [],
      env: {},
      shell: false
    }),
    (error) => error.code === "PROCESS_IDENTITY_UNAVAILABLE"
  );
  assert.deepEqual(signals, [{ pid: 4312, signal: "SIGTERM" }]);
  assert.equal(alive, false, "simulated owned group survivors");
  assert.equal(closes, 1, "the provisional channel is closed exactly once");
  assert.deepEqual(await backend.cleanupAll(), {
    backend: "posix-cooperative",
    level: "registered-drained",
    registered: 0
  });
});

test("parent identity mismatch after authenticated hello fails closed without signaling", async () => {
  let handlers;
  let closes = 0;
  let resolveHello;
  const helloComplete = new Promise((resolve) => {
    resolveHello = resolve;
  });
  let groupSignals = 0;
  const child = new EventEmitter();
  child.pid = 4312;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let inspection = 0;
  const authenticatedIdentity = {
    pid: 4312,
    processGroupId: 4312,
    startTime: "authenticated-start",
    executable: "/usr/bin/node"
  };
  const mismatchedIdentity = {
    ...authenticatedIdentity,
    startTime: "reused-start"
  };
  const backend = createPosixProcessGroupBackend({
    platform: "linux",
    spawn(_command, _args, options) {
      queueMicrotask(async () => {
        await handlers.hello({
          type: "hello",
          version: 1,
          ...identity,
          pid: 4312,
          parentPid: 4000,
          rootCredential: options.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL
        });
        resolveHello();
      });
      return child;
    },
    async createRegistrationChannel(nextHandlers) {
      handlers = nextHandlers;
      return {
        endpoint: "unix:/tmp/cdx-hello-mismatch.sock",
        async close() {
          closes += 1;
        }
      };
    },
    async inspectProcess() {
      inspection += 1;
      if (inspection === 1) {
        await helloComplete;
        return mismatchedIdentity;
      }
      return inspection === 2 ? authenticatedIdentity : mismatchedIdentity;
    },
    killGroup() {
      groupSignals += 1;
    },
    handshakeMs: 25
  });

  await assert.rejects(
    backend.launch({
      ...identity,
      command: "/usr/bin/true",
      args: [],
      env: {},
      shell: false
    }),
    (error) => error.code === "PROCESS_IDENTITY_MISMATCH"
  );
  assert.equal(groupSignals, 0, "a mismatched identity is never signaled");
  assert.equal(closes, 1);
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
    rootCredential:
      fixture.calls[0].options.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL,
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
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error: undefined
  });
});

test("registered descendants are revalidated before fallback termination", async () => {
  const inspections = [];
  const individualKills = [];
  const alive = new Set([4312, 4500]);
  const fixture = controlledBackend({
    async inspectProcess(pid) {
      inspections.push(pid);
      if (!alive.has(pid)) return null;
      return { pid, startTime: pid === 4312 ? "100" : "200", executable: "/usr/bin/node" };
    },
    killGroup(pid, signal) {
      if (signal === "SIGKILL") alive.delete(pid);
    },
    killProcess(pid, signal) {
      individualKills.push({ pid, signal });
      alive.delete(pid);
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

  assert.deepEqual(inspections, [4312, 4500, 4312, 4312, 4500, 4312, 4500]);
  assert.deepEqual(individualKills, [{ pid: 4500, signal: "SIGKILL" }]);
});

test("cleanup sends group SIGTERM, waits a bounded grace, then sends group SIGKILL", async () => {
  const waits = [];
  const groupCalls = [];
  let rootAlive = true;
  const fixture = controlledBackend({
    async inspectProcess(pid) {
      return rootAlive
        ? { pid, startTime: "100", executable: "/usr/bin/node" }
        : null;
    },
    killGroup(pid, signal) {
      groupCalls.push({ type: "kill", pid, signal });
      if (signal === "SIGKILL") rootAlive = false;
    },
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
    groupCalls,
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
  let alive = true;
  const fixture = controlledBackend({
    async inspectProcess(pid) {
      return alive
        ? { pid, startTime: "100", executable: "/usr/bin/node" }
        : null;
    },
    killGroup() {
      alive = false;
    },
    async waitForDrain() {
      return true;
    }
  });
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

test("cleanupAll still drains owned groups after protocol health is lost", async () => {
  let alive = true;
  const signals = [];
  const fixture = controlledBackend({
    async inspectProcess(pid) {
      return alive
        ? { pid, startTime: "100", executable: "/usr/bin/node" }
        : null;
    },
    killGroup(pid, signal) {
      signals.push({ pid, signal });
      alive = false;
    },
    async waitForDrain() {
      return true;
    }
  });
  await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });
  fixture.handlers().lost(new Error("socket closed"));

  await assert.rejects(
    fixture.backend.cleanupAll(),
    (error) => error.code === "PROTOCOL_LOST"
  );
  assert.deepEqual(signals, [
    { pid: 4312, signal: "SIGTERM" }
  ]);
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

for (const platform of ["linux", "darwin"]) {
  test(`${platform} held root keeps a supervised background process owned through completion`, async () => {
    const fixture = heldRootBackend(platform);
    const launched = await launchHeldRoot(fixture);
    fixture.handlers().root({
      type: "root",
      version: 1,
      ...identity,
      rootCredential: fixture.rootCredential(),
      status: 0,
      signal: null
    });

    assert.equal((await launched.root).status, 0);
    const proof = await launched.cleanup();

    assert.deepEqual(proof, {
      backend: "posix-cooperative",
      level: "registered-drained",
      registered: 0
    });
    assert.deepEqual(fixture.groupSignals, [{ pid: 4312, signal: "SIGTERM" }]);
    assert.equal(fixture.processes.size, 0, "supervised process survivors");
  });

  test(`${platform} held-root assertion failure still tears down with zero survivors`, async () => {
    const fixture = heldRootBackend(platform);
    const launched = await launchHeldRoot(fixture);
    let assertionError;
    let proof;

    try {
      assert.fail("deliberate held-root assertion failure");
    } catch (error) {
      assertionError = error;
    } finally {
      proof = await launched.cleanup();
    }

    assert.match(assertionError?.message ?? "", /deliberate held-root assertion failure/);
    assert.deepEqual(proof, {
      backend: "posix-cooperative",
      level: "registered-drained",
      registered: 0
    });
    assert.equal(fixture.processes.size, 0, "supervised process survivors");
  });
}

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

test("clean registration close while the process is live latches PROTOCOL_LOST", async () => {
  let alive = true;
  const fixture = controlledBackend({
    async inspectProcess(pid) {
      return alive
        ? { pid, startTime: pid === 4312 ? "100" : "200", executable: "/usr/bin/node" }
        : null;
    },
    killGroup() {
      alive = false;
    },
    async waitForDrain() {
      return true;
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
    parentPid: 4312
  });

  await fixture.handlers().closed(4500);

  await assert.rejects(
    launched.cleanup(),
    (error) => error.code === "PROTOCOL_LOST"
  );
});

test("cleanup refuses registered-drained while identities remain alive after escalation", async () => {
  const fixture = controlledBackend({
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

  await assert.rejects(
    launched.cleanup(),
    (error) => error.code === "CLEANUP_UNPROVEN"
  );
});

test("public kill routes through authenticated control instead of raw child or PID kill", async () => {
  const fixture = controlledBackend();
  let rawKills = 0;
  fixture.child.kill = () => {
    rawKills += 1;
    return true;
  };
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });

  const stopped = launched.kill("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(stopped, {
    backend: "posix-cooperative",
    stopped: true
  });
  assert.equal(rawKills, 0);
  assert.deepEqual(fixture.calls.at(-1), {
    type: "control",
    pid: 4312,
    frame: {
      type: "stop",
      version: 1,
      ...identity,
      signal: "SIGTERM"
    }
  });
});

test("cancellation requests an authenticated root stop before owned-group cleanup", async () => {
  const processes = new Map([[
    4312,
    {
      pid: 4312,
      processGroupId: 4312,
      startTime: "100",
      executable: "/usr/bin/node"
    }
  ]]);
  let handlers;
  let rootCredential;
  const frames = [];
  const child = new EventEmitter();
  child.pid = 4312;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const backend = createPosixProcessGroupBackend({
    platform: "linux",
    spawn(_command, _args, options) {
      rootCredential = options.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL;
      return child;
    },
    async createRegistrationChannel(nextHandlers) {
      handlers = nextHandlers;
      return {
        endpoint: "unix:/tmp/cdx-cancel.sock",
        async send(pid, frame) {
          frames.push({ pid, frame });
          handlers.root({
            type: "root",
            version: 1,
            ...identity,
            rootCredential,
            status: null,
            signal: frame.signal
          });
        },
        async close() {}
      };
    },
    async inspectProcess(pid) {
      return processes.get(pid) ?? null;
    },
    killGroup(pid, signal) {
      assert.equal(pid, 4312);
      processes.clear();
    },
    async waitForDrain() {
      return true;
    }
  });
  const launched = await backend.launch({
    ...identity,
    command: "/usr/bin/node",
    args: ["-e", "setInterval(()=>{},1000)"],
    env: {},
    shell: false
  });

  assert.deepEqual(launched.kill("SIGINT"), {
    backend: "posix-cooperative",
    stopped: true
  });
  assert.deepEqual(await launched.root, {
    backend: "posix-cooperative",
    status: null,
    signal: "SIGINT",
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error: undefined
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].pid, 4312);
  assert.equal(frames[0].frame.type, "stop");
  assert.equal(frames[0].frame.signal, "SIGINT");
  assert.equal((await launched.cleanup()).registered, 0);
});

test("POSIX async launch writes initial input and exposes writable stdin", async () => {
  const fixture = controlledBackend();
  fixture.child.stdin = new PassThrough();
  let input = Buffer.alloc(0);
  fixture.child.stdin.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
  });
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/cat",
    args: [],
    env: {},
    input: "initial input",
    shell: false
  });

  assert.equal(launched.stdin, fixture.child.stdin);
  await new Promise((resolve) => fixture.child.stdin.once("finish", resolve));
  assert.equal(input.toString(), "initial input");
});

test("POSIX async stdout preserves early output until the caller reads it", async () => {
  let alive = true;
  const fixture = controlledBackend({
    async inspectProcess(pid) {
      return alive
        ? { pid, startTime: "100", executable: "/usr/bin/node" }
        : null;
    },
    killGroup() {
      alive = false;
    },
    async waitForDrain() {
      return true;
    }
  });
  fixture.child.stdout = new PassThrough();
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/node",
    args: [],
    env: {},
    maxBuffer: 32,
    shell: false
  });
  fixture.child.stdout.end("early output");

  const chunks = [];
  for await (const chunk of launched.stdout) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "early output");
  assert.notEqual(launched.stdout, fixture.child.stdout);
  await launched.cleanup();
});

for (const streamName of ["stdout", "stderr"]) {
test(`POSIX async ${streamName} overflow is bounded, requests cancellation, and rejects root`, async () => {
  let handlers;
  const frames = [];
  const child = new EventEmitter();
  child.pid = 4312;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const processes = new Map([[
    4312,
    {
      pid: 4312,
      processGroupId: 4312,
      startTime: "100",
      executable: "/usr/bin/node"
    }
  ]]);
  const backend = createPosixProcessGroupBackend({
    platform: "linux",
    spawn() {
      return child;
    },
    async createRegistrationChannel(nextHandlers) {
      handlers = nextHandlers;
      return {
        endpoint: "unix:/tmp/cdx-output.sock",
        async send(pid, frame) {
          frames.push({ pid, frame });
        },
        async close() {}
      };
    },
    async inspectProcess(pid) {
      return processes.get(pid) ?? null;
    },
    killGroup() {
      processes.clear();
    },
    async waitForDrain() {
      return true;
    }
  });
  const launched = await backend.launch({
    ...identity,
    command: "/usr/bin/node",
    args: [],
    env: {},
    maxBuffer: 4,
    shell: false
  });
  child[streamName].write("12345");

  await assert.rejects(
    launched.root,
    (error) => error.code === "OUTPUT_LIMIT_EXCEEDED"
  );
  assert.equal(frames.at(-1).frame.type, "stop");
  assert.equal(frames.at(-1).frame.signal, "SIGTERM");
  await launched.cleanup();
});
}

test("live POSIX cancellation settles root and completion with truthful terminal evidence", {
  skip: process.platform === "win32"
}, async () => {
  const supervisor = createProcessSupervisor({
    platform: process.platform,
    backendFactories: [() => createPosixProcessGroupBackend()]
  });
  const child = await supervisor.spawnTracked({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    timeout: 5000,
    maxBuffer: 1024
  });
  const pid = child.pid;
  assert.equal(child.kill("SIGINT"), true);
  const result = await child.completion;

  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGINT");
  assert.equal(result.supervisor.requestedSignal, "SIGINT");
  assert.equal(result.supervisor.observedSignal, "SIGINT");
  assert.equal(result.supervisor.terminationCause, "requested-signal");
  assert.equal(result.supervisor.cleanup.level, "registered-drained");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await supervisor.shutdown();
  supervisor.assertHealthy();
});

test("live POSIX overflow failure still drains the owned group with zero survivors", {
  skip: process.platform === "win32"
}, async () => {
  const supervisor = createProcessSupervisor({
    platform: process.platform,
    backendFactories: [() => createPosixProcessGroupBackend()]
  });
  const child = await supervisor.spawnTracked({
    command: process.execPath,
    args: ["-e", "process.stdout.write('overflow');setInterval(()=>{},1000)"],
    timeout: 5000,
    maxBuffer: 4
  });
  const pid = child.pid;
  await assert.rejects(
    child.completion,
    (error) => error.code === "OUTPUT_LIMIT_EXCEEDED"
  );
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(
    supervisor.shutdown(),
    (error) => error.code === "OUTPUT_LIMIT_EXCEEDED"
  );
  assert.throws(
    () => supervisor.assertHealthy(),
    (error) => error.code === "OUTPUT_LIMIT_EXCEEDED"
  );
});

test("hello requires explicit backend identity", async () => {
  const fixture = controlledBackend();
  await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });

  await assert.rejects(
    fixture.handlers().hello({
      type: "hello",
      version: 1,
      epoch: identity.epoch,
      runId: identity.runId,
      nonce: identity.nonce,
      pid: 4500,
      parentPid: 4312
    }),
    (error) => error.code === "PROTOCOL_INVALID_MESSAGE"
  );
});

test("root completion requires explicit matching backend identity", async () => {
  const fixture = controlledBackend();
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });
  fixture.handlers().root({
    type: "root",
    version: 1,
    epoch: identity.epoch,
    runId: identity.runId,
    nonce: identity.nonce,
    status: 0,
    signal: null
  });

  await assert.rejects(
    launched.root,
    (error) => error.code === "PROTOCOL_INVALID_MESSAGE"
  );
});

test("macOS host-strict direct launch refuses before process creation", async () => {
  let launches = 0;
  const backend = createMacosBackend({
    mode: "host-strict",
    createPosixBackend: () => ({
      async launch() {
        launches += 1;
      },
      async cleanupAll() {},
      async shutdown() {}
    })
  });

  await assert.rejects(
    backend.launch({
      ...identity,
      command: "/usr/bin/true",
      args: []
    }),
    (error) => error.code === "CAPABILITY_UNAVAILABLE"
  );
  assert.equal(launches, 0);
});

test("real registration socket rejects an oversized release frame", async () => {
  const channel = await listenOnTestPipe((_message, socket) => {
    socket.write("x".repeat(1024 * 1024 + 1));
  });
  const token = Buffer.from(JSON.stringify({
    version: 1,
    epoch: "epoch-real",
    runId: "run-real",
    nonce: "nonce-real",
    endpoint: channel.endpoint
  })).toString("base64url");
  try {
    await assert.rejects(
      registerControlledDescendant({
        env: { CDX_RELAY_SUPERVISOR_TOKEN: token },
        handshakeMs: 1000
      }),
      (error) => error.code === "PROTOCOL_FRAME_TOO_LARGE"
    );
  } finally {
    await channel.close();
  }
});

test("real registration socket rejects a stalled release handshake", async () => {
  const channel = await listenOnTestPipe(() => {});
  const token = Buffer.from(JSON.stringify({
    version: 1,
    epoch: "epoch-stall",
    runId: "run-stall",
    nonce: "nonce-stall",
    endpoint: channel.endpoint
  })).toString("base64url");
  try {
    await assert.rejects(
      registerControlledDescendant({
        env: { CDX_RELAY_SUPERVISOR_TOKEN: token },
        handshakeMs: 25
      }),
      (error) => error.code === "PROTOCOL_HANDSHAKE_TIMEOUT"
    );
  } finally {
    await channel.close();
  }
});

test("authenticated malformed control traffic still poisons protocol health", async () => {
  const pipe = `\\\\.\\pipe\\cdx-auth-malformed-${process.pid}-${Date.now()}`;
  let lostError;
  const channel = await createNetRegistrationChannel({
    async hello() {},
    root() {},
    async closed() {},
    lost(error) {
      lostError = error;
    }
  }, {
    socketPath: pipe,
    handshakeMs: 1000
  });
  const socket = net.createConnection({ path: pipe });
  socket.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    let pending = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      pending += chunk;
      if (!pending.includes("\n")) return;
      socket.write('{"type":"foreign"}\n');
    });
    socket.once("close", resolve);
    socket.write(`${JSON.stringify({
      type: "hello",
      version: 1,
      ...identity,
      pid: 4312,
      parentPid: 4000
    })}\n`);
  });
  assert.equal(lostError?.code, "PROTOCOL_INVALID_MESSAGE");
  await channel.close();
});

test("root frames require the authenticated hello connection", async () => {
  const pipe = `\\\\.\\pipe\\cdx-root-authority-${process.pid}-${Date.now()}`;
  const credential = "trusted-root-report-credential";
  const roots = [];
  const channel = await createNetRegistrationChannel({
    async hello(message) {
      return {
        rootReporter: message.pid === 4312 &&
          message.rootCredential === credential
      };
    },
    root(message) {
      roots.push(message);
    },
    async closed() {},
    lost(error) {
      assert.fail(error);
    }
  }, {
    socketPath: pipe,
    handshakeMs: 1000
  });
  const writeForeignRoot = async (status) => {
    const socket = net.createConnection({ path: pipe });
    socket.resume();
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("close", resolve);
      socket.once("connect", () => socket.end(`${JSON.stringify({
        type: "root",
        version: 1,
        ...identity,
        rootCredential: credential,
        status,
        signal: null
      })}\n`));
    });
  };

  try {
    await writeForeignRoot(91);
    const shim = net.createConnection({ path: pipe });
    shim.setEncoding("utf8");
    await new Promise((resolve, reject) => {
      let pending = "";
      shim.once("error", reject);
      shim.on("data", (chunk) => {
        pending += chunk;
        if (pending.includes("\n")) resolve();
      });
      shim.write(`${JSON.stringify({
        type: "hello",
        version: 1,
        ...identity,
        pid: 4312,
        parentPid: 4000,
        rootCredential: credential
      })}\n`);
    });
    await writeForeignRoot(92);
    shim.write(`${JSON.stringify({
      type: "root",
      version: 1,
      ...identity,
      rootCredential: credential,
      status: 0,
      signal: null
    })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(roots.map((message) => message.status), [0]);
    shim.destroy();
  } finally {
    await channel.close();
  }
});

test("registration channel bounds frames queued behind a slow hello", async () => {
  const pipe = `\\\\.\\pipe\\cdx-queued-frames-${process.pid}-${Date.now()}`;
  let releaseHello;
  const helloGate = new Promise((resolve) => {
    releaseHello = resolve;
  });
  const channel = await createNetRegistrationChannel({
    async hello() {
      await helloGate;
      return { rootReporter: true };
    },
    root() {
      assert.fail("queued oversized traffic must be rejected before root handling");
    },
    async closed() {},
    lost() {}
  }, {
    socketPath: pipe,
    handshakeMs: 1000
  });
  const socket = net.createConnection({ path: pipe });
  socket.resume();
  const closed = new Promise((resolve, reject) => {
    socket.once("error", () => {});
    socket.once("close", resolve);
    setTimeout(() => reject(new Error("queued frame cap did not close the socket")), 500);
  });
  const rootFrame = `${JSON.stringify({
    type: "root",
    version: 1,
    ...identity,
    rootCredential: "forged",
    status: 0,
    signal: null,
    padding: "x".repeat(600 * 1024)
  })}\n`;

  try {
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(`${JSON.stringify({
      type: "hello",
      version: 1,
      ...identity,
      pid: 4312,
      parentPid: 4000,
      rootCredential: "forged"
    })}\n`);
    socket.write(rootFrame);
    socket.write(rootFrame);
    await closed;
  } finally {
    releaseHello();
    socket.destroy();
    await channel.close();
  }
});

test("real target cannot forge root and never receives the root-report credential", async () => {
  const pipe = `\\\\.\\pipe\\cdx-target-forgery-${process.pid}-${Date.now()}`;
  let channel;
  const writeForeignRoot = async (status) => {
    const socket = net.createConnection({ path: pipe });
    socket.resume();
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("close", resolve);
      socket.once("connect", () => socket.end(`${JSON.stringify({
        type: "root",
        version: 1,
        ...identity,
        rootCredential: "forged",
        status,
        signal: null
      })}\n`));
    });
  };
  const backend = createPosixProcessGroupBackend({
    platform: "linux",
    async createRegistrationChannel(handlers) {
      channel = await createNetRegistrationChannel(handlers, {
        socketPath: pipe,
        handshakeMs: 1000
      });
      await writeForeignRoot(91);
      return channel;
    },
    async inspectProcess(pid) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return null;
        throw error;
      }
      return {
        pid,
        processGroupId: pid,
        startTime: String(pid),
        executable: process.execPath
      };
    },
    terminalFrameMs: 1000
  });
  const targetSource = [
    "const net=require('node:net');",
    "const t=JSON.parse(Buffer.from(process.env.CDX_RELAY_SUPERVISOR_TOKEN,'base64url'));",
    "const seen={ordinaryToken:Boolean(process.env.CDX_RELAY_SUPERVISOR_TOKEN),",
    "rootCredential:process.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL};",
    "const s=net.createConnection({path:t.endpoint.slice(5)});",
    "s.resume();",
    "s.once('error',error=>{console.error(error);process.exitCode=2;});",
    "s.once('connect',()=>s.end(JSON.stringify({type:'root',version:1,",
    "epoch:t.epoch,runId:t.runId,nonce:t.nonce,backend:'posix-cooperative',",
    "rootCredential:'forged',status:97,signal:null})+'\\n'));",
    "s.once('close',()=>process.stdout.write(JSON.stringify(seen)));"
  ].join("");
  const launched = await backend.launch({
    ...identity,
    command: process.execPath,
    args: ["-e", targetSource],
    env: process.env,
    shell: false
  });

  try {
    const completed = await launched.root;
    assert.equal(completed.status, 0);
    if (launched.child.exitCode === null) {
      await new Promise((resolve) => launched.child.once("exit", resolve));
    }
    const targetOutput = [];
    for await (const chunk of launched.stdout) targetOutput.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(targetOutput).toString()), {
      ordinaryToken: true
    });
    assert.deepEqual(await launched.cleanup(), {
      backend: "posix-cooperative",
      level: "registered-drained",
      registered: 0
    });
  } finally {
    await channel?.close();
    await backend.shutdown().catch(() => {});
  }
});

test("default POSIX control socket is private, resists foreign malformed clients, and leaves no residue", {
  skip: process.platform === "win32"
}, async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-control-test-"));
  let lost = 0;
  const channel = await createNetRegistrationChannel({
    async hello() {
      assert.fail("foreign malformed client must not authenticate");
    },
    root() {},
    async closed() {},
    lost() {
      lost += 1;
    }
  }, {
    temporaryRoot,
    handshakeMs: 100
  });
  const socketPath = channel.endpoint.slice("unix:".length);
  const privateDirectory = path.dirname(socketPath);
  assert.equal(fs.statSync(privateDirectory).mode & 0o077, 0);
  assert.equal(fs.statSync(socketPath).mode & 0o077, 0);
  assert.equal(path.dirname(privateDirectory), temporaryRoot);

  const foreign = net.createConnection({ path: socketPath });
  await new Promise((resolve, reject) => {
    foreign.once("error", () => {});
    foreign.once("close", resolve);
    foreign.once("connect", () => foreign.end('{"type":"foreign"}\n'));
    setTimeout(() => reject(new Error("foreign client was not rejected")), 1000);
  });
  assert.equal(lost, 0);

  await channel.close();
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(privateDirectory), false);
  assert.deepEqual(fs.readdirSync(temporaryRoot), []);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test("real launch shim reports root exit while a descendant holds stdout open", async () => {
  const rootCredential = "A".repeat(43);
  let resolveRoot;
  const rootMessage = new Promise((resolve) => {
    resolveRoot = resolve;
  });
  const channel = await listenOnTestPipe((message, socket) => {
    if (message.type === "hello") {
      socket.write(`${JSON.stringify({ type: "release", version: 1 })}\n`);
    } else if (message.type === "root") {
      resolveRoot(message);
    }
  });
  const token = Buffer.from(JSON.stringify({
    version: 1,
    epoch: "epoch-shim",
    runId: "run-shim",
    nonce: "nonce-shim",
    endpoint: channel.endpoint
  })).toString("base64url");
  const targetSource = [
    "const {spawn}=require('node:child_process');",
    "const child=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],",
    "{detached:true,stdio:['ignore',1,2]});",
    "child.unref();"
  ].join("");
  const target = Buffer.from(JSON.stringify({
    command: process.execPath,
    args: ["-e", targetSource]
  })).toString("base64url");
  const shim = spawn(process.execPath, [launchShimPath, target], {
    env: {
      ...process.env,
      CDX_RELAY_SUPERVISOR_TOKEN: token,
      CDX_RELAY_ROOT_REPORT_CREDENTIAL: rootCredential
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  try {
    const message = await Promise.race([
      rootMessage,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("root message timed out")), 1000))
    ]);
    assert.equal(message.status, 0);
    assert.equal(shim.stdout.readableEnded, false);
  } finally {
    shim.kill();
    await channel.close();
  }
});

test("real clean socket close while registered process is live latches protocol loss", async () => {
  let endpoint;
  let registrationChannel;
  let alive = true;
  const fixture = controlledBackend({
    async createRegistrationChannel(handlers) {
      let registeredPid;
      const channel = await listenOnTestPipe(async (message, socket) => {
        registeredPid = message.pid;
        await handlers.hello(message);
        socket.write(`${JSON.stringify({ type: "release", version: 1 })}\n`);
        socket.end();
      }, () => handlers.closed(registeredPid));
      endpoint = channel.endpoint;
      registrationChannel = channel;
      return channel;
    },
    async inspectProcess(pid) {
      return alive
        ? { pid, startTime: pid === 4312 ? "100" : "200", executable: "/usr/bin/node" }
        : null;
    },
    killGroup() {
      alive = false;
    },
    async waitForDrain() {
      return true;
    }
  });
  const launched = await fixture.backend.launch({
    ...identity,
    command: "/usr/bin/true",
    args: [],
    env: {},
    shell: false
  });
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({
      path: endpoint.slice("unix:".length)
    });
    socket.resume();
    socket.setTimeout(1000, () => socket.destroy(new Error("socket close timed out")));
    socket.once("error", reject);
    socket.once("close", resolve);
    socket.write(`${JSON.stringify({
      type: "hello",
      version: 1,
      ...identity,
      pid: 4500,
      parentPid: 4312
    })}\n`);
  });
  await new Promise((resolve) => setImmediate(resolve));

  try {
    await assert.rejects(
      launched.cleanup(),
      (error) => error.code === "PROTOCOL_LOST"
    );
  } finally {
    await registrationChannel.close();
  }
});

test("real broker spawn preserves exact no-token env and adds only an active token", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-broker-env-"));
  const scriptPath = path.join(directory, "capture-env.mjs");
  const outputPath = path.join(directory, "env.json");
  const logFile = path.join(directory, "broker.log");
  const pidFile = path.join(directory, "broker.pid");
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(outputPath)},JSON.stringify(process.env));`
  );
  const originalToken = process.env.CDX_RELAY_SUPERVISOR_TOKEN;
  const originalParentOnly = process.env.TASK4_PARENT_ONLY;
  try {
    process.env.TASK4_PARENT_ONLY = "must-not-leak";
    delete process.env.CDX_RELAY_SUPERVISOR_TOKEN;
    const noTokenChild = spawnBrokerProcess({
      scriptPath,
      cwd: directory,
      endpoint: "unused",
      pidFile,
      logFile,
      env: { ONLY_CALLER_ENV: "present" }
    });
    for (let index = 0; index < 100 && !fs.existsSync(outputPath); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const noTokenEnv = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(noTokenEnv.ONLY_CALLER_ENV, "present");
    assert.equal(noTokenEnv.CDX_RELAY_SUPERVISOR_TOKEN, undefined);
    assert.equal(noTokenEnv.TASK4_PARENT_ONLY, undefined);
    if (noTokenChild.exitCode === null) {
      await new Promise((resolve) => noTokenChild.once("exit", resolve));
    }

    fs.rmSync(outputPath);
    process.env.CDX_RELAY_SUPERVISOR_TOKEN = "active-token";
    const tokenChild = spawnBrokerProcess({
      scriptPath,
      cwd: directory,
      endpoint: "unused",
      pidFile,
      logFile,
      env: { ONLY_CALLER_ENV: "present" }
    });
    for (let index = 0; index < 100 && !fs.existsSync(outputPath); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const tokenEnv = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(tokenEnv.ONLY_CALLER_ENV, "present");
    assert.equal(tokenEnv.CDX_RELAY_SUPERVISOR_TOKEN, "active-token");
    assert.equal(tokenEnv.TASK4_PARENT_ONLY, undefined);
    if (tokenChild.exitCode === null) {
      await new Promise((resolve) => tokenChild.once("exit", resolve));
    }
  } finally {
    if (originalToken === undefined) {
      delete process.env.CDX_RELAY_SUPERVISOR_TOKEN;
    } else {
      process.env.CDX_RELAY_SUPERVISOR_TOKEN = originalToken;
    }
    if (originalParentOnly === undefined) {
      delete process.env.TASK4_PARENT_ONLY;
    } else {
      process.env.TASK4_PARENT_ONLY = originalParentOnly;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("real shim exit without an authenticated root frame rejects PROTOCOL_LOST", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-no-root-"));
  const shimPath = path.join(directory, "no-root.mjs");
  fs.writeFileSync(shimPath, "process.exit(0);");
  let channel;
  const backend = createPosixProcessGroupBackend({
    platform: "linux",
    shimPath,
    async createRegistrationChannel() {
      channel = await listenOnTestPipe(() => {});
      return channel;
    },
    async inspectProcess(pid) {
      return { pid, startTime: "100", executable: process.execPath };
    },
    killGroup() {},
    async waitForDrain() {
      return false;
    },
    graceMs: 1,
    forceMs: 1,
    terminalFrameMs: 25
  });
  const launched = await backend.launch({
    ...identity,
    command: process.execPath,
    args: ["-e", ""],
    env: process.env,
    shell: false
  });
  try {
    await assert.rejects(
      launched.root,
      (error) => error.code === "PROTOCOL_LOST"
    );
  } finally {
    await channel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("authenticated root frame already in transport wins its race with shim exit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-root-race-"));
  const shimPath = path.join(directory, "root-race.mjs");
  fs.writeFileSync(shimPath, [
    "import net from 'node:net';",
    "import process from 'node:process';",
    "const t=JSON.parse(Buffer.from(process.env.CDX_RELAY_SUPERVISOR_TOKEN,'base64url'));",
    "const c=process.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL;",
    "const s=net.createConnection({path:t.endpoint.slice(5)});s.setEncoding('utf8');",
    "await new Promise((resolve,reject)=>{let p='';s.once('error',reject);",
    "s.on('data',c=>{p+=c;if(p.includes('\\n'))resolve();});",
    "s.write(JSON.stringify({type:'hello',version:1,epoch:t.epoch,runId:t.runId,nonce:t.nonce,backend:'posix-cooperative',pid:process.pid,parentPid:process.ppid,rootCredential:c})+'\\n');});",
    "s.write(JSON.stringify({type:'root',version:1,epoch:t.epoch,runId:t.runId,nonce:t.nonce,backend:'posix-cooperative',rootCredential:c,status:17,signal:null})+'\\n',()=>process.exit(0));"
  ].join(""));
  let channel;
  let registeredPid;
  const backend = createPosixProcessGroupBackend({
    platform: "linux",
    shimPath,
    async createRegistrationChannel(handlers) {
      channel = await listenOnTestPipe(async (message, socket) => {
        if (message.type === "hello") {
          registeredPid = message.pid;
          await handlers.hello(message);
          socket.write(`${JSON.stringify({ type: "release", version: 1 })}\n`);
        } else {
          setTimeout(() => handlers.root(message), 10);
        }
      }, () => handlers.closed(registeredPid));
      return channel;
    },
    async inspectProcess(pid) {
      return { pid, startTime: "100", executable: process.execPath };
    },
    terminalFrameMs: 50
  });
  const launched = await backend.launch({
    ...identity,
    command: process.execPath,
    args: ["-e", ""],
    env: process.env,
    shell: false
  });
  try {
    const result = await launched.root;
    assert.equal(result.status, 17);
    assert.equal(result.backend, "posix-cooperative");
  } finally {
    await channel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("foreign slow-drip client is bounded without poisoning authenticated protocol health", async () => {
  const pipe = `\\\\.\\pipe\\cdx-slow-drip-${process.pid}-${Date.now()}`;
  let lostError;
  const channel = await createNetRegistrationChannel({
    async hello() {},
    root() {},
    async closed() {},
    lost(error) {
      lostError = error;
    }
  }, {
    handshakeMs: 35,
    socketPath: pipe
  });
  const started = Date.now();
  const socket = net.createConnection({ path: pipe });
  socket.on("error", () => {});
  const closed = new Promise((resolve) => socket.once("close", resolve));
  const drip = setInterval(() => socket.write("{"), 10);
  try {
    await closed;
    assert.equal(lostError, undefined);
    assert.ok(Date.now() - started < 80);
  } finally {
    clearInterval(drip);
    socket.destroy();
    await channel.close();
  }
});
