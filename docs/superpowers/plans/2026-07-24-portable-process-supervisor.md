# Portable Process Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Windows-coupled Codex Relay test harness with one process-supervisor API that provides strict containment on eligible Windows and Linux hosts, cooperative containment on native macOS, and enforceable cleanup proof on every test result.

**Architecture:** Preserve the existing Windows Job Object implementation, extract it behind a shared coordinator, and add POSIX cooperative and protected Linux cgroup backends. The coordinator owns leases, lifecycle, bounded output, failure latching, and the public sync/async facade; backends own only containment, identity, stop, and drain proof. Atomic state publication remains a separate production commit.

**Tech Stack:** Node.js ESM on Node.js 20+, `node:test`, Windows Job Objects through PowerShell `Add-Type` and C#, Linux cgroups v2 plus pidfds/namespaces through a protected reaper, POSIX process groups, GitHub Actions.

## Global Constraints

- Preserve every tracked and untracked file in the current worktree; do not reset or recreate the Windows WIP.
- Use one public test API on `win32`, `linux`, and `darwin`; ordinary tests must not import platform backends.
- `host-strict` requires kernel containment and drain proof; it never silently falls back to `cooperative`.
- Windows `host-strict` uses Job Objects and proves active-process count zero.
- Linux `host-strict` requires a protected per-run cgroup, an independent failure-surviving reaper, no payload write access to cgroup migration controls, and outer-cgroup `populated 0`.
- Native macOS supports `cooperative`; `host-strict` fails with `CAPABILITY_UNAVAILABLE`.
- External macOS strict evidence is issued only by an outer orchestrator after nonce-bound environment disposal; the in-guest supervisor cannot claim it.
- Process ownership uses supervisor epoch, run ID, random nonce, and backend identity; never terminate an individual raw PID from durable state.
- `run` throws on supervisor or cleanup-proof failure; `completion`, `cleanupAll`, and `shutdown` reject on such failure.
- Every infrastructure failure irreversibly latches supervisor health and mandatory suite teardown rethrows it.
- `trackChild` is cooperative-only during migration and must have zero callers and be removed before completion.
- All protocol frames and stdout/stderr capture are byte-bounded while pipes continue draining.
- Preserve spawnSync-shaped `run` results and the documented child-like subset of `spawnTracked`.
- Keep atomic state/job publication independently testable and committed separately from supervisor extraction.
- Keep the test supervisor separate from the production process adapter.
- Use argument-array spawning with `shell: false`.
- The package aggregate timeout remains exactly `600000` milliseconds; timeout increases are not an accepted fix.
- Implementation agents use `gpt-5.6-sol` medium; verification agents use `gpt-5.6-sol` high.
- Each task follows test-driven development and ends in a focused commit after its review gate passes.

---

## File responsibility map

| Path | Responsibility |
|---|---|
| `plugins/cdx-relay/scripts/lib/state.mjs` | Strict state-index validation and atomic JSON replacement |
| `plugins/cdx-relay/scripts/codex-companion.mjs` | Worker publication handshake tied to current job ID and PID |
| `plugins/cdx-relay/tests/helpers.mjs` | Stable convenience exports and non-process test helpers only |
| `plugins/cdx-relay/tests/process-supervisor/index.mjs` | Public factory and default platform selection |
| `plugins/cdx-relay/tests/process-supervisor/coordinator.mjs` | Epochs, leases, lifecycle, cleanup, failure latch, sync/async result enforcement |
| `plugins/cdx-relay/tests/process-supervisor/errors.mjs` | Normalized supervisor error classes and stable codes |
| `plugins/cdx-relay/tests/process-supervisor/protocol.mjs` | Versioned bounded message schemas and validation |
| `plugins/cdx-relay/tests/process-supervisor/result.mjs` | SpawnSync-shaped and async terminal-result normalization |
| `plugins/cdx-relay/tests/process-supervisor/worker.mjs` | Portable bridge used by synchronous `run` |
| `plugins/cdx-relay/tests/process-supervisor/launch-shim.mjs` | Non-Windows trusted blocked launch and nonce handshake |
| `plugins/cdx-relay/tests/process-supervisor/backends/windows.mjs` | Windows Job controller client and backend adapter |
| `plugins/cdx-relay/tests/process-supervisor/backends/posix-process-group.mjs` | Cooperative process group, registry, identity, and cleanup |
| `plugins/cdx-relay/tests/process-supervisor/backends/macos.mjs` | macOS capability policy and cooperative adapter |
| `plugins/cdx-relay/tests/process-supervisor/backends/linux-cgroup.mjs` | Protected Linux cgroup client, capability probe, and proof validation |
| `plugins/cdx-relay/tests/process-supervisor/native/windows/controller.cs` | Job Object ownership and kernel drain proof |
| `plugins/cdx-relay/tests/process-supervisor/native/windows/controller.ps1` | PowerShell bootstrap for the C# controller |
| `plugins/cdx-relay/tests/process-supervisor/native/windows/worker.mjs` | Persistent Windows controller transport |
| `plugins/cdx-relay/tests/process-supervisor/native/windows/launch-shim.mjs` | Windows target PID and parent/nonce handshake |
| `plugins/cdx-relay/tests/process-supervisor/native/linux/reaper.mjs` | Protected cgroup creation, harness lifetime watch, kill-and-drain, stale-run recovery |
| `plugins/cdx-relay/tests/process-supervisor-contract.test.mjs` | Backend-neutral API and lifecycle contract |
| `plugins/cdx-relay/tests/process-supervisor-windows.test.mjs` | Windows strict adversarial tests |
| `plugins/cdx-relay/tests/process-supervisor-posix.test.mjs` | POSIX/macOS cooperative behavior and strict-refusal tests |
| `plugins/cdx-relay/tests/process-supervisor-linux.test.mjs` | Linux protected-cgroup and reaper adversarial tests |
| `.github/workflows/portable-supervisor.yml` | Windows, Linux strict, and macOS cooperative CI matrix |

### Task 1: Separate atomic state publication from process supervision

**Files:**
- Modify: `plugins/cdx-relay/scripts/lib/state.mjs`
- Modify: `plugins/cdx-relay/scripts/codex-companion.mjs`
- Modify: `plugins/cdx-relay/tests/state.test.mjs`
- Modify: `plugins/cdx-relay/tests/runtime.test.mjs`

**Interfaces:**
- Consumes: existing `resolveStateFile`, `resolveJobFile`, `saveState`, `writeJobFile`, and task-worker `--task-worker <job-id>` flow.
- Produces: `readStateIndexStrict(cwd)`, `validateStateIndexPublicationCandidate(cwd, job)`, atomic `saveState`, atomic `writeJobFile`, and a worker publication gate requiring matching `{ id, pid, request.jobId }` in both files.

- [ ] **Step 1: Make the concurrent atomic-write test failure-safe**

Change the spawned reader/writer fixture in `tests/state.test.mjs` so assertion failure cannot strand it:

```js
const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
  stdio: ["ignore", "ignore", "pipe"]
});
let exited = false;
child.once("exit", () => {
  exited = true;
});

try {
  await waitForFile(`${markerBase}.1`);
  assert.equal(readStateIndexStrict(workspace).jobs[0].generation, "old");
  fs.writeFileSync(`${releaseBase}.1`, "release");
  await waitForFile(`${markerBase}.2`);
  fs.writeFileSync(`${releaseBase}.2`, "release");
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(exitCode, 0, stderr);
} finally {
  fs.writeFileSync(`${releaseBase}.1`, "release");
  fs.writeFileSync(`${releaseBase}.2`, "release");
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}
```

- [ ] **Step 2: Run the state tests before altering implementation**

Run:

```powershell
node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/state.test.mjs
```

Expected: all state tests pass, no timeout, and no temporary `*.tmp` file remains.

- [ ] **Step 3: Finalize strict reads and atomic replacement**

Keep the current `StateIndexCorruptionError`, `readStateIndexStrict`, and `validateStateIndexPublicationCandidate` behavior. Make `atomicWriteJson` preserve existing permission bits, write with `wx`, `fsync` the file, rename in the same directory, and remove its temporary file on every error path:

```js
function atomicWriteJson(filePath, payload) {
  const temporaryFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor;
  try {
    const mode = existingModeOr(filePath, 0o600);
    descriptor = fs.openSync(temporaryFile, "wx", mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryFile, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    removeFileIfExists(temporaryFile);
    throw error;
  }
}
```

The production implementation may use an inline permission lookup rather than a new `existingModeOr` helper, but the observable behavior and cleanup are exact.

- [ ] **Step 4: Finalize the task-worker publication handshake**

The polling loop in `codex-companion.mjs` must proceed only when:

```js
const publicationMatches =
  storedJob?.id === jobId &&
  storedJob.pid === process.pid &&
  storedJob.request?.jobId === jobId &&
  indexedJob?.id === jobId &&
  indexedJob.pid === process.pid &&
  indexedJob.request?.jobId === jobId;
```

Malformed state-index JSON or schema fails immediately with `ERR_STATE_INDEX_CORRUPT`; stale or absent valid publication continues polling until the existing deadline and then reports which current-worker publication was missing.

- [ ] **Step 5: Keep only publication tests in the Task 1 diff**

In `runtime.test.mjs`, retain tests for:

```text
task worker waits for both job-file and index publication
task worker rejects stale index identity
task worker rejects malformed index state
task worker rejects mismatched stored request identity
```

Do not commit unrelated `spawnTracked` call-site conversions in this task. Those working-tree edits remain preserved for Task 6.

- [ ] **Step 6: Run focused publication verification**

Run:

```powershell
node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/state.test.mjs plugins/cdx-relay/tests/runtime.test.mjs
```

Expected: 0 failures, 0 cancellations, and the command exits.

- [ ] **Step 7: Commit the publication slice**

Stage only the production publication changes and their focused test hunks. Verify with:

```powershell
git diff --cached --check
git diff --cached --name-only
```

Expected staged paths: only the four Task 1 files.

Commit:

```powershell
git commit -m "fix: publish Codex task state atomically"
```

### Task 2: Establish the shared supervisor contract and enforcement

**Files:**
- Create: `plugins/cdx-relay/tests/process-supervisor/errors.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor/protocol.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor/result.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor/coordinator.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor/index.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor/worker.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor-contract.test.mjs`
- Modify: `plugins/cdx-relay/tests/helpers.mjs`
- Modify: `plugins/cdx-relay/package.json`

**Interfaces:**
- Consumes: injected backend objects and current helper options `{ cwd, env, input, encoding, timeout, maxBuffer, stdio }`.
- Produces: `createProcessSupervisor(options)`, `run`, `spawnTracked`, `cleanupTrackedChildren`, `assertHealthy`, normalized errors, and the documented child-like `completion` contract.

- [ ] **Step 1: Write contract tests with an injected fake backend**

Create tests that define:

```js
function fakeBackend({
  mode = "cooperative",
  cleanup = { level: "registered-drained" },
  root = { status: 0, signal: null, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) }
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
      return context.createFakeLaunch({ spec, root, cleanup });
    },
    async shutdown() {
      return { stopped: true };
    }
  };
}
```

Cover:

- `host-strict` rejects a cooperative backend with `CAPABILITY_UNAVAILABLE`.
- `run` returns nonzero target status without throwing.
- `run` throws `SupervisorInfrastructureError` when proof is missing.
- `spawnTracked().completion` rejects on proof failure and attaches `error.result`.
- `exit` precedes `completion`; `close` follows settlement.
- `kill` is idempotent and records requested versus observed signal.
- concurrent `cleanupAll()` calls share one operation.
- `shutdown()` refuses later launch with `SUPERVISOR_SHUTDOWN`.
- ignored operation failure is rethrown by `assertHealthy()`.
- protocol messages over the byte cap poison the epoch.
- discovered state without a live matching lease yields `UNREGISTERED_RECORDED_PROCESS` and never calls backend PID termination.

- [ ] **Step 2: Run the contract test and observe failure**

Run:

```powershell
node --test --test-concurrency=1 plugins/cdx-relay/tests/process-supervisor-contract.test.mjs
```

Expected: non-zero exit because the process-supervisor modules do not exist.

- [ ] **Step 3: Implement normalized errors and protocol validation**

`errors.mjs` exports:

```js
export class SupervisorInfrastructureError extends Error {
  constructor(code, message, { cause, result } = {}) {
    super(`${code}: ${message}`, { cause });
    this.name = "SupervisorInfrastructureError";
    this.code = code;
    this.result = result;
  }
}

export class SupervisorCleanupError extends SupervisorInfrastructureError {
  constructor(summary, options = {}) {
    super("CLEANUP_UNPROVEN", "One or more supervised boundaries did not prove cleanup.", {
      ...options,
      result: summary
    });
    this.name = "SupervisorCleanupError";
    this.summary = summary;
  }
}
```

`protocol.mjs` exports `PROTOCOL_VERSION = 1`, `MAX_FRAME_BYTES = 1024 * 1024`, `assertBoundedFrame(buffer)`, and schema validators for `hello`, `launch`, `root`, `stop`, `cleanup`, and `proof`. Validators reject unknown protocol versions, missing epoch/runId/nonce, non-string arguments, and frames larger than `MAX_FRAME_BYTES`.

- [ ] **Step 4: Implement result normalization**

`result.mjs` exports:

```js
export function createTerminalResult({
  root,
  backend,
  cleanup,
  requestedSignal = null,
  terminationCause = "root-exit"
}) {
  return {
    status: root.status ?? null,
    signal: root.signal ?? null,
    stdout: root.stdout,
    stderr: root.stderr,
    error: root.error,
    supervisor: {
      backend: backend.backend,
      mode: backend.mode,
      containment: backend.containment,
      cleanup,
      requestedSignal,
      observedSignal: root.signal ?? null,
      terminationCause
    }
  };
}

export function assertCleanupProven(result, minimumGuarantee) {
  const accepted = minimumGuarantee === "host-strict"
    ? result.supervisor.cleanup?.level === "kernel-drained"
    : ["kernel-drained", "registered-drained"].includes(result.supervisor.cleanup?.level);
  if (!accepted) {
    throw new SupervisorInfrastructureError(
      "CLEANUP_UNPROVEN",
      `Required ${minimumGuarantee} cleanup was not proven.`,
      { result }
    );
  }
  return result;
}
```

- [ ] **Step 5: Implement coordinator lifecycle and failure latch**

`createProcessSupervisor` accepts:

```js
{
  mode = "auto",
  minimumGuarantee = "cooperative",
  platform = process.platform,
  backendFactories = defaultBackendFactories,
  discoverRecordedProcesses = async () => []
}
```

The returned object exposes:

```js
{
  capabilities,
  run,
  spawnTracked,
  cleanupAll,
  shutdown,
  assertHealthy
}
```

Use `randomUUID()` for epochs, run IDs, and nonces. Maintain leases in a private `Map`. A cleanup or transport failure stores the first infrastructure error in `latchedFailure`; `assertHealthy()` always rethrows that first error. `cleanupAll()` and `shutdown()` reject after completing every safe cleanup attempt when any failure exists.

- [ ] **Step 6: Implement the synchronous worker bridge**

Implement the default synchronous bridge in `worker.mjs`. The parent writes a mode-`0o600` request file containing the command, argument array, cwd, environment, input as base64, and output limits; posts `{ requestFile, resultFile, signalBuffer }` to a dedicated Worker; and blocks only on the shared signal:

```js
parentPort.on("message", async ({ requestFile, resultFile, signalBuffer }) => {
  const signal = new Int32Array(signalBuffer);
  try {
    const request = readBoundedRequest(requestFile);
    const result = await supervisor.runAsync(request);
    atomicWriteResult(resultFile, { ok: true, result });
  } catch (error) {
    atomicWriteResult(resultFile, { ok: false, error: serializeError(error) });
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
});
```

The parent reads the bounded result file, recreates `SupervisorInfrastructureError` when `ok` is false, and removes both files in `finally`. Tests inject `syncBridge` so fake backends remain deterministic without serializing functions into the Worker. The Worker calls the coordinator's internal asynchronous `runAsync`; it never recursively calls the public synchronous `run`.

- [ ] **Step 7: Add stable helper wrappers**

`helpers.mjs` imports one suite supervisor and exports:

```js
export const run = (...args) => testSupervisor.run(normalizeRunArgs(...args));
export const spawnTracked = (...args) =>
  testSupervisor.spawnTracked(normalizeSpawnArgs(...args));
export const cleanupTrackedChildren = () => testSupervisor.cleanupAll();
export const assertSupervisorHealthy = () => testSupervisor.assertHealthy();
```

Keep `trackChild` temporarily, but require `{ minimumGuarantee: "cooperative" }` and mark it deprecated in its JSDoc. No new caller may use it.

- [ ] **Step 8: Add mandatory suite teardown**

Provide one fixture registration function:

```js
export function installSupervisorTeardown(afterHook) {
  afterHook(async () => {
    let shutdownError;
    try {
      await testSupervisor.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    testSupervisor.assertHealthy();
    if (shutdownError) throw shutdownError;
  });
}
```

Tests use explicit `after` or `afterEach`; do not install a process-global `beforeExit` listener.

- [ ] **Step 9: Run the contract suite**

Run:

```powershell
node --test --test-concurrency=1 plugins/cdx-relay/tests/process-supervisor-contract.test.mjs
```

Expected: every fake-backend contract test passes and the process exits with 0 failures.

- [ ] **Step 10: Commit the shared contract**

Stage only Task 2 files and commit:

```powershell
git commit -m "test: define portable process supervisor contract"
```

### Task 3: Extract and approve the Windows strict backend

**Files:**
- Create: `plugins/cdx-relay/tests/process-supervisor/backends/windows.mjs`
- Move: `plugins/cdx-relay/tests/windows-job-controller.cs` to `plugins/cdx-relay/tests/process-supervisor/native/windows/controller.cs`
- Move: `plugins/cdx-relay/tests/windows-job-controller.ps1` to `plugins/cdx-relay/tests/process-supervisor/native/windows/controller.ps1`
- Move: `plugins/cdx-relay/tests/windows-job-worker.mjs` to `plugins/cdx-relay/tests/process-supervisor/native/windows/worker.mjs`
- Move: `plugins/cdx-relay/tests/windows-launch-shim.mjs` to `plugins/cdx-relay/tests/process-supervisor/native/windows/launch-shim.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor-windows.test.mjs`
- Modify: `plugins/cdx-relay/tests/helpers.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor/index.mjs`
- Modify: `plugins/cdx-relay/package.json`

**Interfaces:**
- Consumes: the current Job controller protocol, fast-exit handshake, output framing, lease/tombstone behavior, and Task 2 backend contract.
- Produces: `createWindowsBackend(options)` reporting `host-strict`, `kernel`, and `kernel-drained`.

- [ ] **Step 1: Move Windows tests behind the common contract**

Move the existing Windows-gated tests from `helpers.test.mjs` into `process-supervisor-windows.test.mjs`. Import public operations from `process-supervisor/index.mjs`; backend fault-injection tests may additionally import `createWindowsBackend`.

Retain exact adversarial coverage for:

```text
suspended assignment before target release
fast target exit and trusted shim binding
actual target PID handshake
PID reuse and stale publication rejection
lost acknowledgement and controller restart
controller and worker crash
epoch poisoning
4 MiB framed output and dual-stream quota
root snapshot barrier
idempotent correlated tombstone proof
active process zero
detached sleeper ownership
exit/completion/close ordering
ENOENT and nonzero spawnSync result parity
paths with spaces and Unicode
```

- [ ] **Step 2: Run the moved tests before extraction**

Run:

```powershell
node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/process-supervisor-windows.test.mjs
```

Expected: failures identify stale import paths until the backend extraction is complete.

- [ ] **Step 3: Move native files without rewriting their logic**

Update file discovery to:

```js
const NATIVE_ROOT = fileURLToPath(new URL("../native/windows/", import.meta.url));
const WORKER_FILE = path.join(NATIVE_ROOT, "worker.mjs");
const CONTROLLER_FILE = path.join(NATIVE_ROOT, "controller.ps1");
const LAUNCH_SHIM_FILE = path.join(NATIVE_ROOT, "launch-shim.mjs");
```

The first extraction commit preserves the reviewed C# containment core. Renaming internal types is allowed only when required by the move.

- [ ] **Step 4: Implement the Windows backend adapter**

`createWindowsBackend` returns:

```js
{
  async probe() {
    return {
      available: process.platform === "win32" && controllerBootstrapAvailable(),
      capabilities: {
        platform: "win32",
        backend: "windows-job",
        mode: "host-strict",
        containment: "kernel",
        cleanupProof: "kernel-drained",
        supportsDetachedDescendants: true
      }
    };
  },
  launch,
  cleanup,
  shutdown
}
```

Map the current controller lease to the coordinator lease without exposing `controllerPid`, launch IDs, completion-port events, or tombstones to ordinary callers. Cleanup proof validation still requires matching controller epoch, run identity, nonce, terminal state, and active process count zero.

- [ ] **Step 5: Remove Windows implementation from `helpers.mjs`**

After imports are updated, `helpers.mjs` contains no:

```text
runInWindowsJob
cleanupWindowsJobLaunch
getWindowsJobLeaseCount
WINDOWS_JOB_WORKER
WINDOWS_JOB_CONTROLLER
controller request maps
process-global beforeExit handler
```

Fault injection lives on `createWindowsBackend({ faults })`, not on public `run` options.

- [ ] **Step 6: Run Windows focused suites**

Run:

```powershell
node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/process-supervisor-contract.test.mjs plugins/cdx-relay/tests/process-supervisor-windows.test.mjs plugins/cdx-relay/tests/helpers.test.mjs
```

Expected: 0 failures and zero surviving controller, shim, target, or worker processes after the command exits.

- [ ] **Step 7: Commit Windows extraction**

Verify no old native path remains:

```powershell
rg -n "windows-job-controller|windows-job-worker|windows-launch-shim|runInWindowsJob" plugins/cdx-relay/tests
```

Expected: matches only in the new native directory or deliberate test descriptions.

Commit:

```powershell
git commit -m "test: isolate Windows process supervision"
```

### Task 4: Implement POSIX and macOS cooperative supervision

**Files:**
- Create: `plugins/cdx-relay/tests/process-supervisor/launch-shim.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor/backends/posix-process-group.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor/backends/macos.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor-posix.test.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor/index.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor/coordinator.mjs`
- Modify: `plugins/cdx-relay/scripts/codex-companion.mjs`

**Interfaces:**
- Consumes: Task 2 coordinator contract and repository-controlled broker/worker spawn seams.
- Produces: `createPosixProcessGroupBackend(options)`, `createMacosBackend(options)`, and inherited `CDX_RELAY_SUPERVISOR_TOKEN`.

- [ ] **Step 1: Write POSIX cooperative contract tests**

Cover:

- launch shim forms a new process group before target execution.
- target receives a token containing `{ version, epoch, runId, nonce, endpoint }`.
- controlled descendant registers before durable work.
- root exit while a descendant holds stdout open does not deadlock.
- cleanup sends group `SIGTERM`, waits a bounded interval, then group `SIGKILL`.
- registered identities are revalidated before individual fallback termination.
- lost registration channel rejects completion with `PROTOCOL_LOST`.
- unregistered recorded state rejects with `UNREGISTERED_RECORDED_PROCESS`.
- macOS `host-strict` rejects with `CAPABILITY_UNAVAILABLE`.
- Linux cooperative mode reports `registered-drained`, never `kernel-drained`.

- [ ] **Step 2: Run POSIX tests and observe the missing backend**

Run:

```powershell
node --test --test-concurrency=1 plugins/cdx-relay/tests/process-supervisor-posix.test.mjs
```

On Windows, injected platform/process adapters execute deterministic unit coverage. Expected: failure because the modules are absent.

- [ ] **Step 3: Implement the trusted POSIX launch shim**

The shim requires a base64url JSON token:

```js
const token = JSON.parse(
  Buffer.from(process.env.CDX_RELAY_SUPERVISOR_TOKEN, "base64url").toString("utf8")
);
assertToken(token);
await register({
  type: "hello",
  version: 1,
  epoch: token.epoch,
  runId: token.runId,
  nonce: token.nonce,
  pid: process.pid,
  parentPid: process.ppid
});
await waitForRelease();
```

It then spawns the exact command and argument array with `shell: false`, forwards stdin, continuously drains stdout/stderr, and reports root exit separately from boundary cleanup.

- [ ] **Step 4: Implement cooperative process-group cleanup**

Launch the shim with `detached: true` on POSIX. Store `/proc/<pid>/stat` start time and executable on Linux; on macOS store the strongest available `ps` identity plus nonce registration. Cleanup:

```js
process.kill(-lease.rootPid, "SIGTERM");
await waitForRegisteredDrain(graceDeadline);
if (!registryEmpty()) {
  process.kill(-lease.rootPid, "SIGKILL");
  await waitForRegisteredDrain(forceDeadline);
}
return { level: "registered-drained", registered: 0 };
```

`ESRCH` is success only after the registry and root identity prove the owned group is gone. An identity mismatch fails closed.

- [ ] **Step 5: Propagate registration through controlled descendants**

In `codex-companion.mjs`, every broker and task-worker spawn inherits `CDX_RELAY_SUPERVISOR_TOKEN`. When present, a controlled child registers before opening its endpoint, publishing a running job, or starting provider work. The production behavior is unchanged when the variable is absent.

- [ ] **Step 6: Implement macOS capability policy**

`createMacosBackend` wraps the cooperative backend and reports:

```js
{
  platform: "darwin",
  backend: "posix-cooperative",
  mode: "cooperative",
  containment: "cooperative",
  cleanupProof: "registered-drained",
  supportsDetachedDescendants: false
}
```

Reject `host-strict` locally. Do not inspect any environment variable to claim external disposal.

- [ ] **Step 7: Run cooperative tests**

Run:

```powershell
node --test --test-concurrency=1 plugins/cdx-relay/tests/process-supervisor-contract.test.mjs plugins/cdx-relay/tests/process-supervisor-posix.test.mjs plugins/cdx-relay/tests/runtime.test.mjs
```

Expected: injected tests pass on Windows; live POSIX cases run on Linux/macOS and report 0 failures.

- [ ] **Step 8: Commit cooperative backends**

Commit:

```powershell
git commit -m "test: add cooperative POSIX process supervision"
```

### Task 5: Implement protected Linux cgroup supervision

**Files:**
- Create: `plugins/cdx-relay/tests/process-supervisor/backends/linux-cgroup.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor/native/linux/reaper.mjs`
- Create: `plugins/cdx-relay/tests/process-supervisor-linux.test.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor/index.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor/protocol.mjs`
- Create: `.github/workflows/portable-supervisor.yml`

**Interfaces:**
- Consumes: Task 2 backend contract and a protected reaper endpoint created outside the payload trust domain.
- Produces: `createLinuxCgroupBackend(options)`, reaper protocol operations `probe`, `launch`, `cleanup`, `recover`, and `shutdown`, plus `kernel-drained` proof.

- [ ] **Step 1: Write injected and live Linux strict tests**

Injected tests run on every platform and cover:

```text
writable delegation without isolation is unavailable
missing reaper is unavailable
nonce or epoch mismatch poisons the backend
leaf populated zero is insufficient when outer cgroup remains populated
cleanup accepts only outer-cgroup populated zero
coordinator death causes reaper cleanup
stale registry recovery completes before new launch
payload migration attempt is rejected
raw PID discovery never authorizes cleanup
```

Live Linux tests run only when `CDX_RELAY_TEST_LINUX_STRICT=1`. In that mode absence of the required protected runner is a failure, not a skip.

- [ ] **Step 2: Run injected tests and observe failure**

Run:

```powershell
node --test --test-concurrency=1 plugins/cdx-relay/tests/process-supervisor-linux.test.mjs
```

Expected: failure because the Linux backend and reaper are absent.

- [ ] **Step 3: Implement the protected-reaper protocol**

All requests contain:

```js
{
  version: 1,
  operation: "probe" | "launch" | "cleanup" | "recover" | "shutdown",
  epoch,
  runId,
  nonce,
  payload
}
```

The reaper stores a private registry entry:

```js
{
  epoch,
  runId,
  nonceHash,
  harnessPid,
  harnessStartTime,
  outerCgroup,
  payloadCgroup,
  state: "created" | "running" | "draining" | "drained"
}
```

Registry writes use atomic replacement with mode `0o600`. The target never receives the reaper registry path or raw reaper credential.

- [ ] **Step 4: Enforce strict capability prerequisites**

`probe` returns available only when all checks pass:

```text
/sys/fs/cgroup/cgroup.controllers exists
cgroup.kill exists in a disposable probe cgroup
the reaper identity is outside payload PID visibility
the payload mount namespace cannot write cgroup.procs, cgroup.threads, or subtree_control
the reaper can watch the harness with pidfd or an equivalent race-resistant handle
the outer run cgroup can be created and removed
```

Any failed check returns `CAPABILITY_UNAVAILABLE` with a bounded safe reason. A writable user-delegated subtree alone never passes.

- [ ] **Step 5: Implement launch and fail-safe cleanup**

The reaper creates:

```text
<protected-root>/<epoch>-<runId>/
└── payload/
```

It starts the blocked shim in `payload`, validates membership and the restricted namespace, then releases it. The reaper remains outside the outer run cgroup and watches the harness. On explicit cleanup, control-channel loss, or harness death it writes `1` to outer `cgroup.kill`, polls outer `cgroup.events`, and returns success only for `populated 0`.

On startup, `recover` drains every authenticated non-drained registry entry before accepting `launch`.

- [ ] **Step 6: Implement backend proof validation**

The Linux backend accepts:

```js
{
  level: "kernel-drained",
  epoch,
  runId,
  nonceHash,
  outerCgroup,
  populated: 0,
  reaperIdentity,
  drainedAt
}
```

Every field must match the live lease and authenticated reaper channel. Leaf-only evidence, a missing reaper identity, or `populated !== 0` rejects with `CLEANUP_UNPROVEN` and latches the supervisor.

- [ ] **Step 7: Add the Linux strict CI job**

The workflow job uses an Ubuntu runner, prepares a protected test cgroup/reaper boundary with the least privileges required by the live probe, sets `CDX_RELAY_TEST_LINUX_STRICT=1`, and runs:

```yaml
- run: node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/process-supervisor-linux.test.mjs
- run: npm --prefix plugins/cdx-relay test
```

The job must fail when strict capability is unavailable.

- [ ] **Step 8: Run available verification**

On the current host:

```powershell
node --test --test-concurrency=1 plugins/cdx-relay/tests/process-supervisor-linux.test.mjs
```

Expected: injected tests and strict-refusal behavior pass.

On a protected Linux runner:

```bash
CDX_RELAY_TEST_LINUX_STRICT=1 node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/process-supervisor-linux.test.mjs
```

Expected: all live adversarial tests pass, including migration attempts, harness death, and stale-run recovery, with outer `populated 0`.

- [ ] **Step 9: Commit Linux strict support**

Commit:

```powershell
git commit -m "test: add protected Linux process supervision"
```

### Task 6: Migrate all callers and remove compatibility bypasses

**Files:**
- Modify: `plugins/cdx-relay/tests/helpers.mjs`
- Modify: `plugins/cdx-relay/tests/helpers.test.mjs`
- Modify: `plugins/cdx-relay/tests/build-config.test.mjs`
- Modify: `plugins/cdx-relay/tests/bump-version.test.mjs`
- Modify: `plugins/cdx-relay/tests/git.test.mjs`
- Modify: `plugins/cdx-relay/tests/runtime.test.mjs`
- Modify: `plugins/cdx-relay/tests/state.test.mjs`
- Modify: `plugins/cdx-relay/package.json`

**Interfaces:**
- Consumes: Tasks 2–5 public supervisor API.
- Produces: zero `trackChild` callers or exports, no platform conditionals in ordinary tests, and explicit completion/teardown awaits.

- [ ] **Step 1: Add a source-policy test**

In `helpers.test.mjs`, assert:

```js
const ordinaryFiles = [
  "build-config.test.mjs",
  "bump-version.test.mjs",
  "git.test.mjs",
  "runtime.test.mjs",
  "state.test.mjs"
];
for (const file of ordinaryFiles) {
  const source = fs.readFileSync(path.join(TEST_ROOT, file), "utf8");
  assert.doesNotMatch(source, /process\.platform|runInWindowsJob|trackChild|windows-job-/);
}
assert.doesNotMatch(
  fs.readFileSync(path.join(TEST_ROOT, "helpers.mjs"), "utf8"),
  /runInWindowsJob|cleanupWindowsJobLaunch|getWindowsJobLeaseCount|beforeExit/
);
```

- [ ] **Step 2: Convert every live child launch**

Replace raw `spawn` plus `trackChild` and the remaining preserved WIP call sites with:

```js
const child = await spawnTracked(command, args, options);
try {
  const result = await child.completion;
  assert.equal(result.status, expectedStatus);
} finally {
  await cleanupTrackedChildren();
  assertSupervisorHealthy();
}
```

Tests that deliberately need only root `exit` may observe it, but must still await `completion` before returning.

- [ ] **Step 3: Remove per-file Windows cleanup hooks**

Use the shared suite fixture:

```js
import { after } from "node:test";
import { installSupervisorTeardown } from "./helpers.mjs";

installSupervisorTeardown(after);
```

Do not retain `afterEach(cleanupTrackedChildren)` solely because `run` creates a lease. Each `run` owns and proves its own boundary before returning.

- [ ] **Step 4: Remove compatibility APIs**

Delete:

```text
trackChild
registerRecordedProcess as an ownership mechanism
raw-PID termination helpers
Windows-named public helper exports
process-global beforeExit cleanup
```

Recorded-process discovery remains diagnostic and correlates only to active supervisor leases.

- [ ] **Step 5: Make package test coverage explicit**

Update the package `test` script to include:

```text
tests/process-supervisor-contract.test.mjs
tests/process-supervisor-windows.test.mjs
tests/process-supervisor-posix.test.mjs
tests/process-supervisor-linux.test.mjs
```

Keep `--test-concurrency=1` and `--test-timeout=600000`.

- [ ] **Step 6: Run migration scans**

Run:

```powershell
rg -n "trackChild|runInWindowsJob|cleanupWindowsJobLaunch|getWindowsJobLeaseCount|process\\.on\\(\"beforeExit\"" plugins/cdx-relay/tests
```

Expected: no implementation or caller matches.

Run:

```powershell
rg -n "process\\.platform|windows-job-" plugins/cdx-relay/tests/build-config.test.mjs plugins/cdx-relay/tests/bump-version.test.mjs plugins/cdx-relay/tests/git.test.mjs plugins/cdx-relay/tests/runtime.test.mjs plugins/cdx-relay/tests/state.test.mjs
```

Expected: no matches.

- [ ] **Step 7: Run focused migrated suites**

Run:

```powershell
node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/build-config.test.mjs plugins/cdx-relay/tests/bump-version.test.mjs plugins/cdx-relay/tests/git.test.mjs plugins/cdx-relay/tests/helpers.test.mjs plugins/cdx-relay/tests/runtime.test.mjs plugins/cdx-relay/tests/state.test.mjs
```

Expected: 0 failures, 0 cancellations, command exits, and no supervised survivors.

- [ ] **Step 8: Commit caller migration**

Commit:

```powershell
git commit -m "test: migrate Codex suites to portable supervision"
```

### Task 7: Complete cross-platform CI and verification

**Files:**
- Modify: `.github/workflows/portable-supervisor.yml`
- Modify: `plugins/cdx-relay/README.md`
- Modify: `plugins/cdx-relay/package.json`
- Modify: `.superpowers/sdd/progress.md` (ignored durable ledger only)

**Interfaces:**
- Consumes: all previous tasks and platform capability contracts.
- Produces: enforced Windows/Linux/macOS matrix, documented local requirements, and final verification evidence.

- [ ] **Step 1: Define the CI matrix**

The workflow contains:

```yaml
name: portable-supervisor
on:
  pull_request:
  push:
    branches: [main]

jobs:
  native:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm --prefix plugins/cdx-relay test
```

Add the protected Linux strict job from Task 5. Windows must run the strict adversarial suite; macOS must run the cooperative suite and host-strict refusal test.

- [ ] **Step 2: Document capability behavior**

Add a README section that states:

```text
Windows: host-strict through Job Objects when PowerShell Add-Type is available.
Linux: host-strict only with the protected reaper/cgroup runner; otherwise explicit capability failure or cooperative mode when the test permits it.
macOS: native cooperative mode; host-strict is unavailable.
External macOS strict evidence belongs to the disposable-runner orchestrator and is never inferred in guest.
```

Include exact focused test commands and the `CDX_RELAY_TEST_LINUX_STRICT=1` live-gate variable.

- [ ] **Step 3: Commit CI and documentation**

Commit:

```powershell
git commit -m "ci: verify portable process supervision"
```

- [ ] **Step 4: Run static and focused checks**

Run:

```powershell
git diff --check
npm run check:isolation
npm run check:safety
node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/process-supervisor-contract.test.mjs plugins/cdx-relay/tests/process-supervisor-windows.test.mjs plugins/cdx-relay/tests/process-supervisor-posix.test.mjs plugins/cdx-relay/tests/process-supervisor-linux.test.mjs
```

Expected: every command exits 0 and focused tests report no surviving supervised processes.

- [ ] **Step 5: Run the approved package aggregate**

Run:

```powershell
npm --prefix plugins/cdx-relay test
```

Expected: exits within 600 seconds with 0 failures and 0 cancellations. Record the exact pass count, duration, and survivor census.

- [ ] **Step 6: Run the root suite**

Run:

```powershell
npm test
```

Expected: exits with 0 failures and 0 cancellations. Record the exact pass count and duration.

- [ ] **Step 7: Run whole-branch Sol-high review**

Generate a review package from `ae3b1ed` through the final implementation head. The reviewer verifies:

```text
design and plan compliance
state/supervisor commit separation
strict-proof enforcement
Windows Job ownership and drain
Linux escape resistance and reaper survival
macOS cooperative honesty
raw-PID safety
output bounds and protocol poisoning
failure latch and mandatory teardown
zero trackChild or platform leaks
test and CI coverage
```

Fix every Critical or Important finding in one coordinated fix wave, rerun covering tests, commit the fixes, regenerate the review package, and repeat until approved.

- [ ] **Step 8: Re-run final gates and verify branch state**

After any review fix, rerun:

```powershell
npm --prefix plugins/cdx-relay test
npm test
```

Expected: both commands exit with 0 failures and 0 cancellations; package verification remains inside 600 seconds.

Run:

```powershell
git status --short
git log --oneline --decorate -12
```

Expected: no uncommitted implementation files; only ignored SDD artifacts may remain. The branch contains separate commits for design, plan, state publication, shared contract, Windows, POSIX/macOS, Linux, caller migration, and CI.
