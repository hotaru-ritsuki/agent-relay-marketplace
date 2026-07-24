import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  readStateIndexStrict,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  validateStateIndexPublicationCandidate,
  writeJobFile
} from "../scripts/lib/state.mjs";

async function waitForFile(filePath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test("strict state-index reads distinguish absence from malformed content", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);

  assert.equal(readStateIndexStrict(workspace), null);

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{ definitely-not-json", "utf8");

  assert.throws(
    () => readStateIndexStrict(workspace),
    (error) =>
      error?.code === "ERR_STATE_INDEX_CORRUPT" &&
      error?.stateFile === stateFile &&
      /malformed JSON/.test(error.message)
  );
});

test("state index and job JSON publish atomically while a concurrent reader polls", async () => {
  const workspace = makeTempDir();
  const jobId = "atomic-publication";
  saveState(workspace, {
    jobs: [{ id: jobId, status: "queued", generation: "old" }]
  });
  const jobFile = writeJobFile(workspace, jobId, {
    id: jobId,
    status: "queued",
    generation: "old"
  });
  const markerBase = path.join(workspace, "rename-ready");
  const releaseBase = path.join(workspace, "rename-release");
  const stateModule = new URL("../scripts/lib/state.mjs", import.meta.url).href;
  const source = `
    import fs from "node:fs";
    const originalRename = fs.renameSync;
    let renameCount = 0;
    fs.renameSync = (from, to) => {
      renameCount += 1;
      fs.writeFileSync(${JSON.stringify(markerBase)} + "." + renameCount, "ready");
      const release = ${JSON.stringify(releaseBase)} + "." + renameCount;
      while (!fs.existsSync(release)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return originalRename(from, to);
    };
    const { saveState, writeJobFile } = await import(${JSON.stringify(stateModule)});
    saveState(${JSON.stringify(workspace)}, {
      jobs: [{ id: ${JSON.stringify(jobId)}, status: "running", generation: "new" }]
    });
    writeJobFile(${JSON.stringify(workspace)}, ${JSON.stringify(jobId)}, {
      id: ${JSON.stringify(jobId)}, status: "running", generation: "new"
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  try {
    await waitForFile(`${markerBase}.1`);
    assert.equal(readStateIndexStrict(workspace).jobs[0].generation, "old");
    assert.equal(readJobFile(jobFile).generation, "old");
    fs.writeFileSync(`${releaseBase}.1`, "release");

    await waitForFile(`${markerBase}.2`);
    assert.equal(readStateIndexStrict(workspace).jobs[0].generation, "new");
    assert.equal(readJobFile(jobFile).generation, "old");
    fs.writeFileSync(`${releaseBase}.2`, "release");

    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0, stderr);
    assert.equal(readJobFile(jobFile).generation, "new");
    assert.deepEqual(
      [
        path.dirname(resolveStateFile(workspace)),
        path.dirname(jobFile)
      ].flatMap((directory) =>
        fs.readdirSync(directory)
          .filter((entry) => entry.endsWith(".tmp"))
          .map((entry) => path.join(directory, entry))
      ),
      []
    );
  } finally {
    fs.writeFileSync(`${releaseBase}.1`, "release");
    fs.writeFileSync(`${releaseBase}.2`, "release");
    if (!exited) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
});

test("atomic state and job replacement preserves existing permission bits", () => {
  const workspace = makeTempDir();
  const jobId = "permission-preservation";
  saveState(workspace, { jobs: [{ id: jobId, generation: 1 }] });
  const stateFile = resolveStateFile(workspace);
  const jobFile = writeJobFile(workspace, jobId, { id: jobId, generation: 1 });
  fs.chmodSync(stateFile, 0o640);
  fs.chmodSync(jobFile, 0o640);
  const stateMode = fs.statSync(stateFile).mode & 0o777;
  const jobMode = fs.statSync(jobFile).mode & 0o777;

  saveState(workspace, { jobs: [{ id: jobId, generation: 2 }] });
  writeJobFile(workspace, jobId, { id: jobId, generation: 2 });

  assert.equal(fs.statSync(stateFile).mode & 0o777, stateMode);
  assert.equal(fs.statSync(jobFile).mode & 0o777, jobMode);
});

test("atomic replacement preserves exact permission bits under a restrictive umask", async () => {
  const workspace = makeTempDir();
  const jobId = "restrictive-umask";
  saveState(workspace, { jobs: [{ id: jobId, generation: 1 }] });
  const stateFile = resolveStateFile(workspace);
  const jobFile = writeJobFile(workspace, jobId, { id: jobId, generation: 1 });
  fs.chmodSync(stateFile, 0o666);
  fs.chmodSync(jobFile, 0o666);
  const stateMode = fs.statSync(stateFile).mode & 0o777;
  const jobMode = fs.statSync(jobFile).mode & 0o777;
  const stateModule = new URL("../scripts/lib/state.mjs", import.meta.url).href;
  const source = `
    import fs from "node:fs";
    process.umask(0o222);
    const originalOpenSync = fs.openSync;
    fs.openSync = (filePath, flags, mode) =>
      originalOpenSync(filePath, flags, mode & ~process.umask());
    const { saveState, writeJobFile } = await import(${JSON.stringify(stateModule)});
    saveState(${JSON.stringify(workspace)}, {
      jobs: [{ id: ${JSON.stringify(jobId)}, generation: 2 }]
    });
    writeJobFile(${JSON.stringify(workspace)}, ${JSON.stringify(jobId)}, {
      id: ${JSON.stringify(jobId)}, generation: 2
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve) => child.once("exit", resolve));

  assert.equal(exitCode, 0, stderr);
  assert.equal(fs.statSync(stateFile).mode & 0o777, stateMode);
  assert.equal(fs.statSync(jobFile).mode & 0o777, jobMode);
});

test("strict state-index reads reject corrupt job entry schemas", () => {
  const invalidStates = [
    null,
    {},
    { jobs: [null] },
    { jobs: [{}] },
    { jobs: [{ id: "", request: { jobId: "task" } }] },
    { jobs: [{ id: "task", request: { jobId: "" } }] },
    { jobs: [{ id: "task", pid: 0, request: { jobId: "task" } }] },
    { jobs: [{ id: "task", pid: "123", request: { jobId: "task" } }] }
  ];

  for (const [index, state] of invalidStates.entries()) {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");

    assert.throws(
      () => readStateIndexStrict(workspace),
      (error) =>
        error?.code === "ERR_STATE_INDEX_CORRUPT" &&
        error?.stateFile === stateFile &&
        /required schema/.test(error.message),
      `invalid state case ${index}`
    );
  }
});

test("strict state-index reads accept valid mixed historical records", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      jobs: [
        { id: "historical-no-request", pid: null, status: "completed" },
        { id: "historical-null-request", request: null, status: "failed" },
        {
          id: "current-shape",
          pid: 123,
          request: { jobId: "current-shape" },
          status: "running"
        }
      ]
    }),
    "utf8"
  );

  const state = readStateIndexStrict(workspace);

  assert.equal(state.jobs.length, 3);
  assert.equal(state.jobs[0].pid, null);
  assert.equal(state.jobs[1].request, null);
});

test("publication candidates require current pid and request identity", () => {
  const workspace = makeTempDir();

  for (const candidate of [
    { id: "candidate", pid: null, request: { jobId: "candidate" } },
    { id: "candidate", pid: 123, request: null },
    { id: "candidate", pid: 123, request: {} }
  ]) {
    assert.throws(
      () => validateStateIndexPublicationCandidate(workspace, candidate),
      (error) =>
        error?.code === "ERR_STATE_INDEX_CORRUPT" &&
        /publication candidate/.test(error.message)
    );
  }
});

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});
