import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  assertSupervisorHealthy,
  installSupervisorTeardown,
  resolveTestCommand,
  run,
  spawnTracked
} from "./helpers.mjs";

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));

installSupervisorTeardown(after);

test("ordinary suites use only the portable supervisor facade", () => {
  const ordinaryBypasses = new RegExp([
    "process\\.platform",
    "runInWindows" + "Job",
    "track" + "Child",
    "windows-job-"
  ].join("|"));
  const helperBypasses = new RegExp([
    "runInWindows" + "Job",
    "cleanupWindows" + "JobLaunch",
    "getWindows" + "JobLeaseCount",
    "before" + "Exit"
  ].join("|"));
  const ordinaryFiles = [
    "build-config.test.mjs",
    "bump-version.test.mjs",
    "git.test.mjs",
    "runtime.test.mjs",
    "state.test.mjs"
  ];
  for (const file of ordinaryFiles) {
    const source = fs.readFileSync(path.join(TEST_ROOT, file), "utf8");
    assert.doesNotMatch(source, ordinaryBypasses);
  }
  assert.doesNotMatch(
    fs.readFileSync(path.join(TEST_ROOT, "helpers.mjs"), "utf8"),
    helperBypasses
  );
});

test("run returns the portable terminal result", () => {
  const result = run(process.execPath, ["-e", "process.stdout.write('portable')"]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "portable");
  assert.equal(result.supervisor.cleanup.level === "kernel-drained" ||
    result.supervisor.cleanup.level === "registered-drained", true);
  assertSupervisorHealthy();
});

test("spawnTracked exposes root exit and portable completion", async () => {
  const child = await spawnTracked(
    process.execPath,
    ["-e", "process.stdout.write('tracked')"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  const rootStatus = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const completion = await child.completion;

  assert.equal(rootStatus, 0);
  assert.equal(completion.status, 0);
  assert.equal(stdout, "tracked");
  assertSupervisorHealthy();
});

test("command resolution remains data-only without a shell", () => {
  assert.deepEqual(resolveTestCommand("tool", "linux", {}), {
    command: "tool",
    shell: false
  });
});
