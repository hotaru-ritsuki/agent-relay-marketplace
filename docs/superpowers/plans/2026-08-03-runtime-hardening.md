# Agent Relay Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the verified broker, RPC, state, process-supervisor, reaper, and policy-enforcement failure modes while preserving independent plugins and native Windows/Linux/macOS behavior.

**Architecture:** Put authoritative test discovery and CI gates first. Then make broker/app-server lifecycle explicit and revocable, serialize revisioned state mutations with explicit deletion, require process-start identity before durable-PID termination, make every supervisor launch terminal, and close the remaining scanner/parser/result/sync defects behind executable negative controls.

**Tech Stack:** Node.js 20+ ESM, `node:test`, pinned `proper-lockfile@4.1.2`, JSON-over-socket broker RPC, Windows PowerShell/CIM and Job Objects, POSIX process groups, Linux cgroups v2 reaper, GitHub Actions.

## Global Constraints

- Work only in `D:/PersonalProjects/agent-relay-marketplace/.worktrees/agent-relay-marketplace` on `feature/agent-relay-marketplace`; preserve the main worktree and its untracked `.idea/` directory.
- Keep `/cdx-relay:*` and `/cursor-relay:*` independent. Never add an `/agent-relay:*` runtime or create an absent plugin as a side effect.
- Root tests discover only `tests/`, existing `plugins/cdx-relay/tests/`, and existing `plugins/cursor-relay/tests/`; ignored `.scratch/` tests must never execute.
- Root `npm run check` is an enforced CI gate on Windows, macOS, and Linux before later hardening is accepted.
- Every behavior change follows TDD: demonstrate the focused negative control failing, implement the minimum fix, then run the focused and relevant aggregate suites.
- Readiness is revocable. A ready broker whose app-server child exits must transition to failed, invalidate its endpoint, and terminate.
- Socket liveness is process identity only after a nonce-authenticated exchange. A failed handshake never authorizes raw-PID termination.
- A durable PID may be killed only after matching stored process-start identity, or by the exact `ChildProcess` handle retained by the spawning invocation. Identity-unavailable and identity-mismatch paths fail closed.
- Use `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart= -o command=` on macOS, and `Get-CimInstance Win32_Process` on Windows. Do not use `wmic` or shell-string spawning.
- Short control and admission RPCs have per-method deadlines. Long turn completion has no hidden blanket wall-clock deadline; caller timeout and transport death are its termination mechanisms.
- `saveState` never deletes artifacts. Only an explicit removal API may prune, and the new state revision must be durable before artifact deletion starts.
- Shared state read-modify-write operations use one proven cross-process lock with bounded retry and stale-lock recovery plus revision checking; CAS alone is insufficient.
- Cancellation intent is durable before termination; cancelled terminal state is durable only after a terminal process result.
- Every accepted supervisor launch emits exactly one public terminal outcome and settles all waiters even when a controller or pipe fails.
- Linux reaper recovery persists `empty` before cgroup removal and finalizes payload output on stream `close`, not process `exit`.
- Protocol, stdout, and stderr buffers remain bounded. The package aggregate timeout remains exactly `600000` milliseconds.
- Platform claims require platform evidence: no mocked Linux/macOS result may substitute for the live CI gates.
- Implementer commits are focused. Each task receives a separate read-only spec/quality review before the next implementer starts.

---

### Task 1: Make authoritative test discovery and CI enforcement real

**Files:**
- Create: `tooling/run-tests.mjs`
- Create: `tests/test-discovery.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/portable-supervisor.yml`

**Interfaces:**
- Produce `collectAuthoritativeTests(repoRoot)` returning sorted absolute `*.test.mjs` paths beneath approved, already-existing test roots.
- Produce `runAuthoritativeTests({ repoRoot, nodeArgs })`, spawning `process.execPath` with argument arrays and `shell: false`.
- Root `npm test` becomes `node tooling/run-tests.mjs`; `npm run check` remains the aggregate entry point.

- [ ] **Step 1: Write the discovery negative control**

Use a temporary fixture containing `tests/kept.test.mjs`, `plugins/cdx-relay/tests/kept.test.mjs`, `.scratch/stale.test.mjs`, and no Cursor plugin. Assert the collector returns exactly the two authoritative files, does not create `plugins/cursor-relay`, and returns stable sorted paths.

- [ ] **Step 2: Run it red**

Run `node --test --test-concurrency=1 tests/test-discovery.test.mjs`.

Expected: FAIL because `tooling/run-tests.mjs` and its exported collector do not exist.

- [ ] **Step 3: Implement explicit discovery**

Walk only the approved roots, reject symlink traversal in the test manifest, append explicit file paths after Node's fixed `--test`, `--test-concurrency=1`, and `--test-timeout=600000` arguments, and propagate a non-zero child exit unchanged.

- [ ] **Step 4: Wire CI before other fixes**

Replace package-only aggregate steps with `npm run check` in both native and Linux jobs. Retain the explicit Windows strict, macOS cooperative, and Linux protected-cgroup steps as named platform evidence.

- [ ] **Step 5: Prove positive and negative behavior**

Run:

```powershell
node --test --test-concurrency=1 tests/test-discovery.test.mjs
npm test
npm run check
```

Expected: PASS; ignored `.scratch/*.test.mjs` files are absent from the manifest and policy/isolation failures preserve non-zero exit status.

- [ ] **Step 6: Commit**

Commit: `test: enforce authoritative root checks`

---

### Task 2: Make app-server transport death and short RPC deadlines terminal

**Files:**
- Modify: `plugins/cdx-relay/scripts/lib/app-server.mjs`
- Modify: `plugins/cdx-relay/scripts/lib/codex.mjs`
- Modify: `plugins/cdx-relay/tests/runtime.test.mjs`
- Modify: `plugins/cdx-relay/tests/fake-codex-fixture.mjs`

**Interfaces:**
- Extend `AppServerClient.request(method, params, { timeoutMs } = {})`.
- Add `deadlineForMethod(method)` for short control/admission defaults.
- Keep long turn completion caller-controlled; `captureTurn(..., { timeoutMs })` may bound the whole turn only when supplied by its caller.

- [ ] **Step 1: Add failing transport/deadline tests**

Add real child-process fixtures proving: peer exit sets `closed`, rejects every pending request, and empties the pending map; a peer that stays connected but never replies rejects a short control call at its method deadline; `turn/start` admission is bounded; a multi-minute-style turn completion simulated with a delayed notification is not cut off by the admission deadline.

- [ ] **Step 2: Add the stdin write-pressure negative control**

Use a child that closes stdin while the parent writes a payload larger than the pipe buffer. Assert the client rejects cleanly without `uncaughtException`, `EPIPE`, or Windows `EOF` escaping.

- [ ] **Step 3: Run focused tests red**

Run `node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/runtime.test.mjs`.

Expected: the new terminal/deadline/write-pressure cases fail or time out on the old implementation.

- [ ] **Step 4: Implement total transport shutdown**

Make exit/error/close converge on one idempotent close path that marks the client closed, removes and rejects all pending requests, settles long-turn listeners, and installs callback/listener handling for stdin write failure.

- [ ] **Step 5: Implement method-specific deadlines**

Use 30 seconds for ordinary control/admission calls, allow focused tests to inject smaller values, clear timers on every settlement path, and never apply the admission timer to the later turn-completion notification.

- [ ] **Step 6: Verify and commit**

Run focused runtime tests and `npm --prefix plugins/cdx-relay test`.

Commit: `fix: make app server requests terminal`

---

### Task 3: Make broker readiness authenticated, revocable, and cleanable

**Files:**
- Create: `plugins/cdx-relay/scripts/lib/process-identity.mjs`
- Modify: `plugins/cdx-relay/scripts/lib/broker-lifecycle.mjs`
- Modify: `plugins/cdx-relay/scripts/app-server-broker.mjs`
- Modify: `plugins/cdx-relay/scripts/session-lifecycle-hook.mjs`
- Modify: `plugins/cdx-relay/tests/broker-endpoint.test.mjs`
- Modify: `plugins/cdx-relay/tests/runtime.test.mjs`

**Interfaces:**
- Produce `captureProcessIdentity(pid)` and `matchesProcessIdentity(expected, actual)`.
- Persist broker `{ state, endpoint, pid, nonce, processIdentity }`.
- Broker methods `status` and `shutdown` require the stored nonce.
- `ensureBrokerSession` retains its spawned child handle until ready/failure is settled.

- [ ] **Step 1: Add the cold-start orphan negative control**

Delay broker initialization beyond the startup budget. Assert `ensureBrokerSession` rejects, its exact child reaches a terminal event, no endpoint becomes reachable later, and diagnostic metadata is not deleted before cleanup is proved.

- [ ] **Step 2: Add revocable-readiness and blocked-shutdown tests**

Prove a ready broker exits and invalidates metadata after `appClient.exitPromise` rejects. Separately block the broker event loop so authenticated shutdown times out; assert teardown kills only after the current OS identity matches the stored identity.

- [ ] **Step 3: Add PID-reuse/identity-unavailable controls**

Inject mismatched and unavailable identity probes. Assert teardown does not call the process-tree terminator, retains actionable metadata, and reports a bounded failure. Test Linux `/proc`, macOS `ps`, and Windows CIM parsing independently without claiming non-host execution.

- [ ] **Step 4: Run focused tests red**

Run broker endpoint and selected runtime tests. Expected: delayed startup orphans, ready state is not revoked, shutdown hangs, and stale identity is trusted.

- [ ] **Step 5: Implement the lifecycle state machine**

Publish `starting` before spawn, publish `ready` only after a nonce-authenticated status response, observe child exit to publish/act on `failed`, and converge all startup failures through exact-child cleanup. Use a 5-second shutdown request deadline.

- [ ] **Step 6: Implement named identity probes**

Use argument-array spawning and `shell: false`; never use `wmic`. Normalize platform records so equality requires PID, start identity, and executable/command identity. If no proof is available, fail closed.

- [ ] **Step 7: Verify and commit**

Run broker endpoint tests, runtime tests, process tests, then the package suite.

Commit: `fix: make broker readiness revocable`

---

### Task 4: Serialize revisioned state and make deletion explicit

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `plugins/cdx-relay/scripts/lib/state.mjs`
- Modify: `plugins/cdx-relay/scripts/session-lifecycle-hook.mjs`
- Modify: `plugins/cdx-relay/tests/state.test.mjs`
- Modify: `plugins/cdx-relay/tests/runtime.test.mjs`

**Interfaces:**
- Add `StateConflictError`.
- State shape includes integer `revision` defaulting to `0` for legacy files.
- `saveState(cwd, snapshot)` compare-and-swaps `snapshot.revision` and never deletes.
- `updateState(cwd, mutate)` serializes, reloads, increments revision, and atomically publishes.
- Add `removeJobs(cwd, ids)` and `pruneJobArtifacts(cwd, removedJobs)`.

- [ ] **Step 1: Pin the lock dependency**

Install exactly `proper-lockfile@4.1.2` at the workspace root and commit both manifest and lockfile changes. Configure locking against the state directory with `realpath: false`, bounded retries, heartbeat, and stale recovery.

- [ ] **Step 2: Add stale-snapshot and concurrent-writer negatives**

Prove a stale `saveState` throws `StateConflictError` without changing the newer state or deleting its job JSON/log. Spawn concurrent upserts and config writes; assert every acknowledged mutation survives and revisions increase.

- [ ] **Step 3: Add explicit-prune crash-order tests**

Instrument publication and deletion. Assert the state revision excluding explicit IDs is durable before `pruneJobArtifacts` starts, deletion is idempotent, and an artifact absent from a snapshot but not listed for removal survives.

- [ ] **Step 4: Add stale-lock recovery test**

Have a child acquire the state lock and exit without releasing it. After the configured stale interval, assert a later update recovers and publishes without corrupting state. Keep the production stale interval conservative and allow the test to inject a shorter lock policy through a narrow internal seam.

- [ ] **Step 5: Run state tests red**

Run `node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/state.test.mjs`.

Expected: stale save deletes or overwrites newer data and concurrent writers lose updates.

- [ ] **Step 6: Implement lock + revision + explicit removal**

Acquire before loading, publish atomically while held, release in `finally`, and surface compromised-lock failures. `saveState` only writes. Session cleanup calls `removeJobs` with explicit IDs and prunes the returned records after publication.

- [ ] **Step 7: Verify and commit**

Run state tests, runtime tests, then root `npm run check`.

Commit: `fix: serialize state mutations and pruning`

---

### Task 5: Make cancellation durable and POSIX termination complete

**Files:**
- Modify: `plugins/cdx-relay/scripts/codex-companion.mjs`
- Modify: `plugins/cdx-relay/scripts/lib/process.mjs`
- Modify: `plugins/cdx-relay/scripts/lib/tracked-jobs.mjs`
- Modify: `plugins/cdx-relay/tests/process.test.mjs`
- Modify: `plugins/cdx-relay/tests/runtime.test.mjs`

**Interfaces:**
- Cancellation states: running/queued -> cancelling -> cancelled, with `cancelRequestedAt`.
- `terminateProcessTree(pid)` on POSIX attempts the direct PID when group termination reports `ESRCH`.

- [ ] **Step 1: Add failing POSIX `ESRCH` fallback test**

Inject process-kill behavior where `kill(-pid)` returns `ESRCH` and `kill(pid)` succeeds. Assert the direct PID is attempted and terminal cleanup is reported.

- [ ] **Step 2: Add cancellation crash-window tests**

Pause immediately before termination and assert state already says `cancelling`. Simulate termination failure and assert the job does not become falsely `cancelled`. Repeat cancellation and assert idempotency.

- [ ] **Step 3: Run focused tests red**

Run process and runtime tests; expected failures demonstrate the inverted fallback and kill-before-persist order.

- [ ] **Step 4: Implement the ordered protocol**

Publish intent through the serialized state API, request termination, await/observe the terminal process result, and only then publish `cancelled`. Preserve a recoverable failure when termination cannot be proved.

- [ ] **Step 5: Verify and commit**

Run process, runtime, state, and package suites.

Commit: `fix: persist cancellation before termination`

---

### Task 6: Guarantee Windows and POSIX supervisor terminal outcomes

**Files:**
- Modify: `plugins/cdx-relay/tests/process-supervisor/backends/windows.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor/launch-shim.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor/result.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor-contract.test.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor-windows.test.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor-posix.test.mjs`

**Interfaces:**
- Every accepted tracked launch settles `completion` and emits exactly one terminal public outcome.
- Controller poison clears launch references in `finally` and rejects current/future launches.
- Launch-shim stdin forwarding consumes pipe errors without uncaught exceptions.

- [ ] **Step 1: Add controller-failure terminal-event tests**

Force the Windows async wait path to reject before a normal child exit. Assert public `error`, `exit`/`close`, and `completion` settle exactly once, supervisor health latches, and no stale launch remains registered.

- [ ] **Step 2: Add launch-shim `EPIPE` test**

Use a target that closes stdin immediately while receiving a large input. Assert the shim reports a bounded launch failure and no uncaught pipe error.

- [ ] **Step 3: Add result normalization test**

Prove backend failure cannot leave the root exit promise waiting only for an event that the failure path never emits.

- [ ] **Step 4: Run host-focused tests red**

Run contract, Windows, and POSIX supervisor suites. Expected: new failure paths hang or omit terminal events on the old code.

- [ ] **Step 5: Implement one idempotent terminalization path**

Centralize terminal delivery, clear references before surfacing poison, explicitly handle forwarded pipe errors, and preserve the existing public result shape.

- [ ] **Step 6: Verify and commit**

Run the three focused suites and the Codex Relay package suite on native Windows.

Commit: `fix: settle supervisor failures exactly once`

---

### Task 7: Make Linux reaper cleanup and output crash-consistent

**Files:**
- Modify: `plugins/cdx-relay/tests/process-supervisor/native/linux/reaper.mjs`
- Modify: `plugins/cdx-relay/tests/process-supervisor-linux.test.mjs`

**Interfaces:**
- Durable lifecycle: `active -> draining -> empty -> drained`.
- Recovery from `empty` performs idempotent directory removal without reading removed cgroup controls.
- Payload result finalizes on `close` after stdout/stderr drain.

- [ ] **Step 1: Add the remove-before-persist crash negative**

Inject a crash immediately after cgroup removal but before the old `drained` write. Restart recovery and assert it reaches `drained` without trying to read a missing `cgroup.events`/outer control file.

- [ ] **Step 2: Add late-output negative**

Use a payload whose descendant keeps stdout open and emits a final marker after the root process `exit` but before stream `close`. Assert the marker is present once and output limits still apply.

- [ ] **Step 3: Run live Linux tests red**

Run the protected reaper suite on the Ubuntu strict runner. Expected: recovery is poisoned or the final marker is truncated.

- [ ] **Step 4: Implement the durable `empty` protocol**

Persist `empty` immediately after `populated 0`; make removal tolerate `ENOENT`; have recovery branch on durable state and persist `drained` only after removal completes.

- [ ] **Step 5: Finalize on `close`**

Record process exit status separately, continue draining both pipes, and construct the terminal payload only when the child `close` event confirms stream closure.

- [ ] **Step 6: Verify and commit**

Run Linux strict tests and the package suite in live Ubuntu CI.

Commit: `fix: make linux reaper recovery durable`

---

### Task 8: Close policy-scanner and filesystem/sync coverage gaps

**Files:**
- Modify: `tooling/check-forbidden-flags.mjs`
- Modify: `tooling/fs-walk.mjs`
- Modify: `tooling/sync-contracts.mjs`
- Modify: `tests/tooling.test.mjs` or the existing focused tooling test files selected by the implementer

**Interfaces:**
- Safety scanning includes executable tests and structured sandbox/config values.
- Filesystem walking reports symlinks explicitly and never follows them outside the requested root.
- Contract sync updates only plugin directories that already exist.

- [ ] **Step 1: Add policy negatives**

Fixtures must fail for `danger-full-access` in structured JSON/config and for forbidden launch flags in test code. Verify the scanner process exits non-zero, not merely that it prints text.

- [ ] **Step 2: Add symlink and absent-plugin negatives**

Create an in-root symlink and an out-of-root symlink. Assert the walker exposes link metadata without traversal. Run sync with Cursor Relay absent and assert it remains absent while Codex Relay contracts update.

- [ ] **Step 3: Run focused tests red**

Expected: structured danger is missed, tests are excluded, links disappear, and sync creates the absent plugin.

- [ ] **Step 4: Implement fail-closed scanning/walking/sync**

Parse supported structured files, scan executable test sources, use `lstat` for links, reject traversal, and gate each sync destination on pre-existence.

- [ ] **Step 5: Verify and commit**

Run focused tooling tests, `npm run check:safety`, `npm run check:isolation`, and root `npm run check`.

Commit: `fix: close tooling enforcement gaps`

---

### Task 9: Preserve arguments and report running jobs correctly

**Files:**
- Modify: `plugins/cdx-relay/scripts/lib/args.mjs`
- Modify: `plugins/cdx-relay/scripts/lib/job-control.mjs`
- Modify: `plugins/cdx-relay/tests/commands.test.mjs`
- Modify: `plugins/cdx-relay/tests/runtime.test.mjs`

**Interfaces:**
- Argument parsing preserves literal backslashes except where the documented grammar consumes an escape.
- `result` distinguishes running, completed, failed, cancelled, and missing jobs; live jobs are never reported as missing.

- [ ] **Step 1: Add parser table tests**

Cover Windows paths, UNC-like inputs, backslashes before ordinary characters, escaped quotes, whitespace, and trailing backslashes. Expected tokens must reflect the documented command grammar.

- [ ] **Step 2: Add running-result negative**

Publish a valid running job and invoke result retrieval. Assert it returns a running/not-ready response and does not enter the missing-job branch.

- [ ] **Step 3: Run focused tests red**

Expected: literal backslashes are stripped and the running job is misreported.

- [ ] **Step 4: Implement minimal parser/control-flow fixes**

Use a small state machine for quoting/escaping and move status branching before terminal-only result validation so the existing terminal paths remain unchanged.

- [ ] **Step 5: Verify and commit**

Run commands, runtime, render, and package suites.

Commit: `fix: preserve relay arguments and live status`

---

### Task 10: Run aggregate native and external platform gates

**Files:**
- Modify only if a gate reveals a real defect: the smallest owning source/test file
- Verify: `.github/workflows/portable-supervisor.yml`

**Interfaces:**
- One root command is the repository merge gate.
- Named platform jobs remain separately visible for Windows strict, macOS cooperative/strict refusal, and Linux protected-cgroup evidence.

- [ ] **Step 1: Run native Windows aggregate**

Run:

```powershell
npm ci
npm run check
node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/process-supervisor-windows.test.mjs
```

Expected: all pass with no unhandled exceptions, timeouts, leaked tracked processes, or stray warnings.

- [ ] **Step 2: Run macOS gate**

In GitHub Actions, run root `npm run check` plus the named POSIX/macOS suite. Expected: cooperative behavior passes and `host-strict` refuses with `CAPABILITY_UNAVAILABLE`.

- [ ] **Step 3: Run live Ubuntu strict gate**

Start the protected reaper exactly as the workflow specifies, run the Linux strict suite, then root `npm run check`. Expected: cgroup drain proof, crash recovery, late-output capture, and aggregate checks all pass.

- [ ] **Step 4: Verify negative controls remain meaningful**

Temporarily inject each guarded defect in a disposable copy or focused fixture and confirm the corresponding command exits non-zero: scratch-test discovery, forbidden structured sandbox access, broker startup orphan, stale-state prune, unverified PID kill, omitted supervisor terminal event, reaper crash window, and late output.

- [ ] **Step 5: Whole-branch review**

Generate a review package from the plan baseline to HEAD. A fresh high-capability reviewer checks the complete design, cross-task contracts, platform evidence, dependency pin, and absence of raw-PID or inferred-deletion paths.

- [ ] **Step 6: Final verification record**

Record exact commands, host OS, commit SHA, pass/fail counts, skipped capability tests, and CI run links in the task report. Do not claim platforms whose live gates did not run.

- [ ] **Step 7: Commit only if verification required a code correction**

Commit: `fix: close runtime hardening verification gaps`

---

## Plan self-review checklist

- [ ] Every confirmed defect has a task and a behavioral negative control.
- [ ] Policy/CI enforcement is Task 1 and gates all later work.
- [ ] Broker identity names Linux, macOS, and Windows mechanisms and fails closed.
- [ ] Readiness can transition from ready back to failed.
- [ ] Long turn completion is not subject to the short admission deadline.
- [ ] State deletion is explicit, publication precedes pruning, and stale snapshots conflict.
- [ ] Cross-process serialization includes bounded retry and stale-lock recovery.
- [ ] Reaper cgroup removal and stream-close defects are explicit tasks.
- [ ] File paths, interfaces, red/green commands, and commit boundaries are concrete.
- [ ] No placeholder markers remain.
