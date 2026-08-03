# Agent Relay Runtime Hardening Design

Date: 2026-08-03  
Status: approved for implementation

## Executive summary

The Codex Relay runtime and its portable process-supervisor tests have a connected set of lifecycle, state-integrity, and policy-enforcement defects. The most visible failure is a broker cold start that can orphan a live broker after the caller gives up and deletes its metadata. Other confirmed failures leave requests pending after transport death, delete job artifacts from a stale state snapshot, trust durable PIDs without process identity, lose terminal events, truncate reaper output, and allow safety checks to pass without inspecting important files or structured sandbox values.

The repair is a phased hardening program. Test discovery and CI enforcement land first so every later negative control is an actual gate. Runtime changes then establish explicit lifecycle state, bounded control operations, revision-safe state mutation, and verified process ownership. Platform-specific supervisor and reaper repairs follow. Small parser, result, filesystem-walk, and contract-sync defects land last behind those gates.

## Goals

1. A broker cold start either reaches authenticated readiness or is cleaned up without losing the evidence needed to recover it.
2. Readiness is revocable: loss of the app-server child changes a ready broker to failed and invalidates its endpoint.
3. Every short RPC/control operation has a bounded failure path, while legitimate long-running turns remain caller-controlled.
4. Transport death rejects every pending request and every long-turn completion.
5. State updates from concurrent processes cannot silently erase an acknowledged update.
6. Artifact deletion is explicit and never inferred from absence in a caller-owned snapshot.
7. No durable PID is terminated unless its process-start identity is verified; unverifiable ownership fails closed.
8. Windows, Linux, and macOS supervisor contracts always produce one terminal result for every launch.
9. Linux reaper recovery is crash-consistent and captures output through stream closure.
10. Root checks discover only authoritative tests and run in CI on every supported operating system.

## Non-goals

- A universal wall-clock timeout for full Codex turns.
- Treating a successful socket connection without nonce authentication as process identity.
- Replacing the existing portable test supervisor architecture.
- Adding an umbrella plugin or coupling Codex Relay to Cursor Relay.
- Creating a missing Cursor Relay plugin directory during contract synchronization.
- Killing a process merely because its PID appears in a stale JSON file.

## Confirmed failure model

The implementation must close these demonstrated failure classes:

- Broker startup can exceed the caller's readiness wait, after which the caller deletes session metadata while the broker later becomes reachable.
- Broker shutdown and app-server requests can wait forever when the peer remains alive but stops responding.
- App-server transport exit does not mark the client closed or reject pending calls.
- Direct writes to a child stdin pipe can raise an unhandled `EPIPE`/`EOF` error under pressure.
- `saveState` treats a job missing from a stale snapshot as an instruction to delete a newer job file and log.
- POSIX process-group cleanup skips the direct PID when group termination returns `ESRCH`.
- Windows launch/controller failures can reject one internal waiter without delivering the public terminal event.
- Linux reaper recovery can remove a cgroup before durably recording the intermediate state, and can finalize output at process `exit` before pipes close.
- The forbidden-flag scanner excludes tests and misses structured `danger-full-access` values.
- Filesystem walking silently skips symlinks, argument parsing removes literal backslashes, a running job can be reported as missing, and contract sync creates an absent plugin.

## Architectural decisions

### 1. Enforcement precedes hardening

Root `npm test` will use an explicit test manifest generated from authoritative roots only:

- `tests/`
- `plugins/cdx-relay/tests/`
- `plugins/cursor-relay/tests/` only when that plugin already exists

Ignored directories such as `.scratch/` are never searched. The root `check` command will run on Windows, macOS, and Linux CI before any task is considered complete. Negative-control tests must fail when their corresponding defect is reintroduced.

### 2. Broker lifecycle is a revocable state machine

The broker lifecycle is:

```text
absent -> starting -> ready -> failed -> removed
```

Only a nonce-authenticated status exchange can publish `ready`. The broker watches the app-server child's `exitPromise`; a child exit after readiness transitions the broker back to `failed`, closes the listener, invalidates metadata, and exits non-zero.

Startup owns the exact `ChildProcess` handle it created. If readiness fails in that same invocation, cleanup uses that handle. Later teardown first attempts authenticated graceful shutdown. If that fails, it compares a stored process-start identity with the current OS identity before process-tree termination. An unavailable or mismatched identity fails closed and preserves diagnostics.

Process identity mechanisms are explicit:

- Linux: `/proc/<pid>/stat` field 22 plus executable identity.
- macOS: `ps -o lstart= -o command= -p <pid>` through argument-array spawning.
- Windows: `Get-CimInstance Win32_Process` through non-interactive PowerShell; `wmic` is not used.

The Windows identity fallback is needed only when the original child handle is gone and authenticated shutdown failed. If PowerShell or CIM is unavailable, the runtime does not kill the PID.

### 3. Deadlines are per operation

Short operations have defaults:

- broker status/readiness probe: 2 seconds per attempt, bounded by an overall startup budget;
- broker shutdown request: 5 seconds;
- ordinary app-server control/admission RPC: 30 seconds;
- `turn/start`: the admission response uses the control deadline;
- long turn completion: no hidden blanket deadline; the caller may provide an overall timeout and transport death always rejects it.

Timeouts reject with a method- and endpoint-specific error and remove their pending request entry.

### 4. State writes and deletion are separate

State receives a monotonic `revision`. Every shared read-modify-write operation runs under a cross-process lock and reloads the latest state after acquiring it. The implementation uses the pinned `proper-lockfile@4.1.2` package against the state directory, with bounded retries, mtime heartbeat/stale recovery, and `realpath: false`.

`saveState` performs compare-and-swap against the revision supplied by its caller and only writes state. A stale snapshot raises `StateConflictError`; it never deletes files. Normal production mutation uses `updateState`, which acquires the lock, reloads, mutates, increments the revision, atomically replaces `state.json`, and releases.

Explicit removal is:

1. `removeJobs(cwd, ids)` acquires the lock and reloads current state.
2. It removes exactly those IDs and publishes the newer state revision.
3. It releases the state lock.
4. `pruneJobArtifacts(cwd, removedJobs)` idempotently deletes only the captured job JSON and log paths.

Publication therefore precedes deletion. Absence from a snapshot is never interpreted as deletion intent.

### 5. Cancellation is durable before termination

Cancellation first publishes `cancelRequestedAt`/`cancelling`, then requests termination through the process adapter, then publishes `cancelled` only after a terminal process result. Repeated cancellation is idempotent. A failed or unverifiable termination remains recoverable state rather than a false terminal success.

### 6. Supervisor terminal results are total

Every accepted launch produces exactly one public terminal event and settles every waiter. Backend/controller faults poison the supervisor, clear stale launch references, reject current and future work, and still deliver the public error/close/exit contract expected by the coordinator. Pipe forwarding handles errors explicitly.

### 7. Reaper cleanup is a durable protocol

Linux cgroup drain recovery uses durable states:

```text
active -> draining -> empty -> drained
```

After observing `populated 0`, the reaper writes `empty` before removing directories. Directory removal is idempotent. Recovery from `empty` skips reads that require an existing cgroup, repeats removal, and then writes `drained`.

Payload capture finalizes on child `close` after stdout and stderr drain, not on `exit`. The result preserves all bounded output received before stream closure.

## Verification strategy

Each task follows red-green-refactor discipline and creates a focused commit. A separate read-only reviewer checks both specification compliance and code quality. Aggregate completion requires:

- root `npm run check` on native Windows;
- the full Codex Relay package suite;
- Windows strict process-supervisor tests;
- macOS cooperative/strict-refusal CI;
- live Ubuntu protected-cgroup/reaper CI;
- negative controls for test discovery and policy scanning;
- a clean tracked worktree after generated artifacts are excluded.

External platform jobs are evidence gates, not claims inferred from local mocks.
