import test from "node:test";
import assert from "node:assert/strict";

import {
  spawnBackgroundProcess,
  terminateProcessTree,
  waitForProcessTreeExit
} from "../scripts/lib/process.mjs";

test("supervised cooperative background spawn stays in its owned process group", () => {
  let captured;
  let unrefs = 0;
  const child = {
    unref() {
      unrefs += 1;
    }
  };

  const result = spawnBackgroundProcess(
    process.execPath,
    ["worker.mjs"],
    {
      cwd: "/workspace",
      env: { CDX_RELAY_SUPERVISOR_TOKEN: "active-token" },
      stdio: "ignore"
    },
    {
      spawn(command, args, options) {
        captured = { command, args, options };
        return child;
      }
    }
  );

  assert.equal(result, child);
  assert.equal(captured.options.detached, false);
  assert.equal(unrefs, 1);
});

test("ordinary background spawn remains detached without a cooperative token", () => {
  let detached;

  spawnBackgroundProcess("node", ["worker.mjs"], { env: {} }, {
    spawn(_command, _args, options) {
      detached = options.detached;
      return { unref() {} };
    }
  });

  assert.equal(detached, true);
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree falls back to the direct POSIX pid when the process group is missing", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid === -1234) {
        throw Object.assign(new Error("missing process group"), { code: "ESRCH" });
      }
    }
  });

  assert.deepEqual(calls, [
    [-1234, "SIGTERM"],
    [1234, "SIGTERM"]
  ]);
  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("terminateProcessTree preserves non-ESRCH POSIX process-group errors", () => {
  const calls = [];
  const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });

  assert.throws(
    () => terminateProcessTree(1234, {
      platform: "linux",
      killImpl(pid, signal) {
        calls.push([pid, signal]);
        throw denied;
      }
    }),
    (error) => error === denied
  );
  assert.deepEqual(calls, [[-1234, "SIGTERM"]]);
});

test("waitForProcessTreeExit reports POSIX terminality only after group and pid are absent", async () => {
  const calls = [];
  const outcome = await waitForProcessTreeExit(1234, {
    platform: "linux",
    timeoutMs: 0,
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    }
  });

  assert.deepEqual(calls, [
    [-1234, 0],
    [1234, 0]
  ]);
  assert.deepEqual(outcome, {
    terminal: true,
    reason: "process-tree-exited"
  });
});

test("waitForProcessTreeExit does not turn a live process into terminal proof", async () => {
  const outcome = await waitForProcessTreeExit(1234, {
    platform: "win32",
    timeoutMs: 0,
    killImpl() {}
  });

  assert.deepEqual(outcome, {
    terminal: false,
    reason: "termination-unconfirmed"
  });
});
