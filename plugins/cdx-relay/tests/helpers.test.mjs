import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  cleanupTrackedChildren,
  makeTempDir,
  resolveTestCommand,
  run,
  trackChild
} from "./helpers.mjs";
import { resolveStateDir } from "../scripts/lib/state.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    child.exitCode = 0;
    child.emit("exit", 0);
    return true;
  };
  return child;
}

test("cleanup terminates a tracked child that is still running", async () => {
  const child = trackChild(fakeChild());

  await cleanupTrackedChildren();

  assert.equal(child.killCalls, 1);
});

test("normal child exit unregisters it from cleanup", async () => {
  const child = trackChild(fakeChild());
  child.exitCode = 0;
  child.emit("exit", 0);

  await cleanupTrackedChildren();

  assert.equal(child.killCalls, 0);
});

test("run registers recorded broker and worker processes for cleanup", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const broker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const stopIfRunning = (child) => {
    if (child.exitCode === null) child.kill();
  };
  t.after(() => {
    stopIfRunning(broker);
    stopIfRunning(worker);
  });
  fs.writeFileSync(
    path.join(stateDir, "broker.json"),
    JSON.stringify({ pid: broker.pid }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify({ jobs: [{ pid: worker.pid, status: "running" }] }),
    "utf8"
  );

  run(process.execPath, ["-e", ""], { cwd: workspace });
  await cleanupTrackedChildren();

  const exited = (child) => new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    child.once("exit", () => resolve(true));
    setTimeout(() => resolve(false), 3000).unref();
  });
  assert.deepEqual(await Promise.all([exited(broker), exited(worker)]), [true, true]);
});
