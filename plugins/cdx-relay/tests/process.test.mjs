import test from "node:test";
import assert from "node:assert/strict";

import {
  spawnBackgroundProcess,
  terminateProcessTree
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
