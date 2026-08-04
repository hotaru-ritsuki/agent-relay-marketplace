import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

import properLockfile from "proper-lockfile";

import {
  assertSupervisorHealthy,
  cleanupTrackedChildren,
  installSupervisorTeardown,
  makeTempDir,
  spawnTracked
} from "./helpers.mjs";
import * as stateApi from "../scripts/lib/state.mjs";
import {
  loadState,
  readStateIndexStrict,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setConfig,
  upsertJob,
  updateState,
  validateStateIndexPublicationCandidate,
  writeJobFile
} from "../scripts/lib/state.mjs";

installSupervisorTeardown(after);

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForCondition(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for state condition");
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
    ...loadState(workspace),
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
    const { loadState, saveState, writeJobFile } = await import(${JSON.stringify(stateModule)});
    saveState(${JSON.stringify(workspace)}, {
      ...loadState(${JSON.stringify(workspace)}),
      jobs: [{ id: ${JSON.stringify(jobId)}, status: "running", generation: "new" }]
    });
    writeJobFile(${JSON.stringify(workspace)}, ${JSON.stringify(jobId)}, {
      id: ${JSON.stringify(jobId)}, status: "running", generation: "new"
    });
  `;
  const child = await spawnTracked(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let exited = false;
  const completionPromise = child.completion.then((completion) => {
    exited = true;
    return completion;
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

    const completion = await completionPromise;
    assert.equal(completion.status, 0, stderr);
    assertSupervisorHealthy();
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
      await completionPromise;
      assertSupervisorHealthy();
    }
  }
});

test("atomic state and job replacement preserves existing permission bits", () => {
  const workspace = makeTempDir();
  const jobId = "permission-preservation";
  let snapshot = saveState(workspace, {
    ...loadState(workspace),
    jobs: [{ id: jobId, generation: 1 }]
  });
  const stateFile = resolveStateFile(workspace);
  const jobFile = writeJobFile(workspace, jobId, { id: jobId, generation: 1 });
  fs.chmodSync(stateFile, 0o640);
  fs.chmodSync(jobFile, 0o640);
  const stateMode = fs.statSync(stateFile).mode & 0o777;
  const jobMode = fs.statSync(jobFile).mode & 0o777;

  snapshot = saveState(workspace, {
    ...snapshot,
    jobs: [{ id: jobId, generation: 2 }]
  });
  writeJobFile(workspace, jobId, { id: jobId, generation: 2 });

  assert.equal(fs.statSync(stateFile).mode & 0o777, stateMode);
  assert.equal(fs.statSync(jobFile).mode & 0o777, jobMode);
});

test("atomic replacement preserves exact permission bits under a restrictive umask", async () => {
  const workspace = makeTempDir();
  const jobId = "restrictive-umask";
  saveState(workspace, {
    ...loadState(workspace),
    jobs: [{ id: jobId, generation: 1 }]
  });
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
    const { loadState, saveState, writeJobFile } = await import(${JSON.stringify(stateModule)});
    saveState(${JSON.stringify(workspace)}, {
      ...loadState(${JSON.stringify(workspace)}),
      jobs: [{ id: ${JSON.stringify(jobId)}, generation: 2 }]
    });
    writeJobFile(${JSON.stringify(workspace)}, ${JSON.stringify(jobId)}, {
      id: ${JSON.stringify(jobId)}, generation: 2
    });
  `;
  const child = await spawnTracked(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const completion = await child.completion;

  assert.equal(completion.status, 0, stderr);
  assertSupervisorHealthy();
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
    { jobs: [{ id: "task", pid: "123", request: { jobId: "task" } }] },
    { revision: -1, jobs: [] },
    { revision: 1.5, jobs: [] },
    { revision: "1", jobs: [] }
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
  assert.equal(state.revision, 0);
  assert.equal(state.jobs[0].pid, null);
  assert.equal(state.jobs[1].request, null);
});

test("saveState rejects a stale snapshot without changing newer state or job artifacts", () => {
  const workspace = makeTempDir();
  const jobId = "conflict-preserved";
  const initial = saveState(workspace, {
    ...loadState(workspace),
    jobs: [{ id: jobId, status: "queued" }]
  });
  const jobFile = writeJobFile(workspace, jobId, { id: jobId, status: "queued" });
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "preserve this log\n", "utf8");
  const staleSnapshot = { ...initial, jobs: [] };
  const newer = upsertJob(workspace, { id: jobId, status: "running" });
  const stateFile = resolveStateFile(workspace);
  const stateBeforeConflict = fs.readFileSync(stateFile, "utf8");
  const jobBeforeConflict = fs.readFileSync(jobFile, "utf8");
  const logBeforeConflict = fs.readFileSync(logFile, "utf8");
  let conflict = null;

  try {
    saveState(workspace, staleSnapshot);
  } catch (error) {
    conflict = error;
  }

  assert.deepEqual(
    {
      isConflictType:
        typeof stateApi.StateConflictError === "function" &&
        conflict instanceof stateApi.StateConflictError,
      name: conflict?.name ?? null,
      code: conflict?.code ?? null,
      expectedRevision: conflict?.expectedRevision,
      actualRevision: conflict?.actualRevision,
      stateUnchanged: fs.readFileSync(stateFile, "utf8") === stateBeforeConflict,
      state: loadState(workspace),
      job: fs.existsSync(jobFile) ? fs.readFileSync(jobFile, "utf8") : null,
      log: fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : null
    },
    {
      isConflictType: true,
      name: "StateConflictError",
      code: "ERR_STATE_CONFLICT",
      expectedRevision: initial.revision,
      actualRevision: newer.revision,
      stateUnchanged: true,
      state: newer,
      job: jobBeforeConflict,
      log: logBeforeConflict
    }
  );
});

test("concurrent upserts and config writes preserve every acknowledged mutation", async () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      revision: 0,
      config: { stopReviewGate: false },
      jobs: []
    }, null, 2)}\n`,
    "utf8"
  );
  const releaseFile = path.join(workspace, "concurrent-release");
  const stateModule = new URL("../scripts/lib/state.mjs", import.meta.url).href;
  const operations = Array.from({ length: 8 }, (_, index) => ({
    index,
    kind: index % 2 === 0 ? "job" : "config",
    readyFile: path.join(workspace, `concurrent-ready-${index}`),
    ackFile: path.join(workspace, `concurrent-ack-${index}`)
  }));
  const children = [];
  const stderr = new Map();

  try {
    for (const operation of operations) {
      const source = `
        import fs from "node:fs";
        import path from "node:path";
        const operation = ${JSON.stringify(operation)};
        const stateFile = ${JSON.stringify(stateFile)};
        const releaseFile = ${JSON.stringify(releaseFile)};
        const originalReadFileSync = fs.readFileSync;
        let delayedStateRead = false;
        fs.readFileSync = (filePath, ...args) => {
          const value = originalReadFileSync(filePath, ...args);
          if (!delayedStateRead && path.resolve(String(filePath)) === path.resolve(stateFile)) {
            delayedStateRead = true;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
          }
          return value;
        };
        const { setConfig, upsertJob } = await import(${JSON.stringify(stateModule)});
        fs.writeFileSync(operation.readyFile, "ready", "utf8");
        while (!fs.existsSync(releaseFile)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        const snapshot = operation.kind === "job"
          ? upsertJob(${JSON.stringify(workspace)}, {
              id: "concurrent-job-" + operation.index,
              status: "queued"
            })
          : setConfig(
              ${JSON.stringify(workspace)},
              "concurrentConfig" + operation.index,
              "value-" + operation.index
            );
        fs.writeFileSync(
          operation.ackFile,
          JSON.stringify({ revision: snapshot.revision }),
          "utf8"
        );
      `;
      const child = await spawnTracked(process.execPath, ["--input-type=module", "-e", source], {
        stdio: ["ignore", "ignore", "pipe"],
        shell: false
      });
      let output = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        output += chunk;
        stderr.set(operation.index, output);
      });
      children.push(child);
    }

    await Promise.all(operations.map((operation) => waitForFile(operation.readyFile)));
    fs.writeFileSync(releaseFile, "release", "utf8");
    const completions = await Promise.all(children.map((child) => child.completion));

    assert.deepEqual(
      completions.map((completion) => completion.status),
      operations.map(() => 0),
      [...stderr.values()].join("\n")
    );
    assertSupervisorHealthy();
    const acknowledgements = operations.map((operation) =>
      JSON.parse(fs.readFileSync(operation.ackFile, "utf8"))
    );
    const state = loadState(workspace);

    assert.equal(state.revision, operations.length);
    assert.deepEqual(
      state.jobs.map((job) => job.id).sort(),
      operations
        .filter((operation) => operation.kind === "job")
        .map((operation) => `concurrent-job-${operation.index}`)
        .sort()
    );
    for (const operation of operations.filter((entry) => entry.kind === "config")) {
      assert.equal(state.config[`concurrentConfig${operation.index}`], `value-${operation.index}`);
    }
    assert.deepEqual(
      acknowledgements.map(({ revision }) => revision).sort((left, right) => left - right),
      Array.from({ length: operations.length }, (_, index) => index + 1)
    );
  } finally {
    if (!fs.existsSync(releaseFile)) {
      fs.writeFileSync(releaseFile, "release", "utf8");
    }
    await cleanupTrackedChildren();
    assertSupervisorHealthy();
  }
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

test("saveState caps the index without treating absent jobs as artifact deletion intent", () => {
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

  saveState(workspace, loadState(workspace));

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.revision, 1);
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 51 }, (_, index) => `job-${index}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("removeJobs publishes explicit removals before idempotent artifact pruning", () => {
  const workspace = makeTempDir();
  const removedId = "remove-explicitly";
  const retainedId = "retain-current";
  const orphanId = "never-indexed";
  const removedLog = resolveJobLogFile(workspace, removedId);
  const retainedLog = resolveJobLogFile(workspace, retainedId);
  const orphanLog = resolveJobLogFile(workspace, orphanId);
  const removedJobFile = writeJobFile(workspace, removedId, { id: removedId });
  const retainedJobFile = writeJobFile(workspace, retainedId, { id: retainedId });
  const orphanJobFile = writeJobFile(workspace, orphanId, { id: orphanId });
  fs.writeFileSync(removedLog, "remove\n", "utf8");
  fs.writeFileSync(retainedLog, "retain\n", "utf8");
  fs.writeFileSync(orphanLog, "orphan\n", "utf8");
  const initial = saveState(workspace, {
    ...loadState(workspace),
    jobs: [
      { id: removedId, status: "completed", logFile: removedLog },
      { id: retainedId, status: "completed", logFile: retainedLog }
    ]
  });

  assert.equal(typeof stateApi.removeJobs, "function");
  assert.equal(typeof stateApi.pruneJobArtifacts, "function");
  const removed = stateApi.removeJobs(workspace, [removedId, "not-current"]);
  const published = loadState(workspace);

  assert.deepEqual(removed.map((job) => job.id), [removedId]);
  assert.equal(published.revision, initial.revision + 1);
  assert.deepEqual(published.jobs.map((job) => job.id), [retainedId]);
  assert.equal(properLockfile.checkSync(resolveStateDir(workspace), { realpath: false }), false);
  assert.equal(fs.existsSync(removedJobFile), true);
  assert.equal(fs.existsSync(removedLog), true);

  const deletionSnapshots = [];
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (filePath) => {
    if (filePath === removedJobFile || filePath === removedLog) {
      deletionSnapshots.push(loadState(workspace));
    }
    return originalUnlinkSync(filePath);
  };
  try {
    stateApi.pruneJobArtifacts(workspace, removed);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(deletionSnapshots.length, 2);
  for (const stateAtDeletion of deletionSnapshots) {
    assert.equal(stateAtDeletion.revision, published.revision);
    assert.deepEqual(stateAtDeletion.jobs.map((job) => job.id), [retainedId]);
  }
  assert.equal(fs.existsSync(removedJobFile), false);
  assert.equal(fs.existsSync(removedLog), false);
  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLog), true);
  assert.equal(fs.existsSync(orphanJobFile), true);
  assert.equal(fs.existsSync(orphanLog), true);
  assert.doesNotThrow(() => stateApi.pruneJobArtifacts(workspace, removed));
});

test("state lock acquisition does not retry non-contention errors", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const originalLockSync = properLockfile.lockSync;
  properLockfile.lockSync = () => {
    throw Object.assign(new Error("state storage denied"), { code: "EACCES" });
  };
  let outcome;

  try {
    updateState(workspace, (state) => {
      state.config.marker = "must-not-publish";
    });
    outcome = null;
  } catch (error) {
    outcome = error;
  } finally {
    properLockfile.lockSync = originalLockSync;
  }

  assert.equal(outcome?.code, "EACCES");
  assert.equal(fs.existsSync(stateFile), false);
});

test("state lock compromise errors are surfaced after publication", () => {
  const workspace = makeTempDir();
  const originalLockSync = properLockfile.lockSync;
  properLockfile.lockSync = () => () => {
    throw Object.assign(new Error("state lock compromised"), { code: "ECOMPROMISED" });
  };
  let outcome;

  try {
    updateState(workspace, (state) => {
      state.config.marker = "published-before-release";
    });
    outcome = null;
  } catch (error) {
    outcome = error;
  } finally {
    properLockfile.lockSync = originalLockSync;
  }

  assert.equal(outcome?.code, "ECOMPROMISED");
  assert.equal(loadState(workspace).config.marker, "published-before-release");
});

test("a crashed child lock becomes stale and a later update recovers", async () => {
  assert.equal(typeof stateApi.setStateLockPolicyForTests, "function");
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const lockDir = `${stateDir}.lock`;
  const markerFile = path.join(workspace, "child-lock-acquired");
  const stateModule = new URL("../scripts/lib/state.mjs", import.meta.url).href;
  const restorePolicy = stateApi.setStateLockPolicyForTests({
    stale: 2_000,
    update: 1_000,
    retryTimeoutMs: 5_000,
    retryDelayMs: 25
  });
  const source = `
    import fs from "node:fs";
    import properLockfile from "proper-lockfile";
    const { ensureStateDir, resolveStateDir } = await import(${JSON.stringify(stateModule)});
    ensureStateDir(${JSON.stringify(workspace)});
    const stateDir = resolveStateDir(${JSON.stringify(workspace)});
    properLockfile.lockSync(stateDir, {
      realpath: false,
      stale: 2_000,
      update: 1_000
    });
    fs.writeFileSync(
      ${JSON.stringify(markerFile)},
      String(fs.statSync(stateDir + ".lock").mtimeMs),
      "utf8"
    );
    setInterval(() => {}, 1_000);
  `;
  const child = await spawnTracked(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let completed = false;

  try {
    await waitForFile(markerFile);
    const initialMtime = Number(fs.readFileSync(markerFile, "utf8"));
    await waitForCondition(() => fs.statSync(lockDir).mtimeMs > initialMtime, 6_000);
    child.kill("SIGKILL");
    await child.completion;
    completed = true;
    assertSupervisorHealthy();
    assert.equal(fs.existsSync(lockDir), true, stderr);

    const recovered = setConfig(workspace, "recoveredAfterCrash", true);

    assert.equal(recovered.revision, 1);
    assert.equal(recovered.config.recoveredAfterCrash, true);
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    if (!completed) {
      child.kill("SIGKILL");
      await child.completion;
    }
    restorePolicy();
    await cleanupTrackedChildren();
    assertSupervisorHealthy();
  }
});
