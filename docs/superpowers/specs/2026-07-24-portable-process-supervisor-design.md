# Portable Test Process Supervisor Design

Date: 2026-07-24
Status: architecture direction approved; awaiting review of this written specification

## 1. Executive summary

The Codex Relay test harness needs reliable process cleanup on Windows, Linux, and macOS without exposing platform-specific behavior to ordinary tests. The current uncommitted implementation proves a strong Windows containment model, but it embeds a large Windows Job Object controller and Windows-specific lifecycle behavior directly in the shared test helper.

The approved design replaces that coupling with one test-scoped `ProcessSupervisor` API, a platform-neutral coordinator, and small operating-system backends:

- Windows uses Job Objects and provides strict kernel containment and drain proof.
- Linux uses a protected cgroups v2 boundary owned by an independent host reaper, supplemented by pidfds and namespaces where available, and provides strict kernel containment and drain proof.
- Native macOS uses a cooperative process-group and descendant-registration protocol.
- A request for host-strict native macOS containment fails with `CAPABILITY_UNAVAILABLE`. A disposable native macOS runner may separately supply an external strict verdict after the environment is destroyed.

The supervisor never silently downgrades a strict request. Tests declare the cleanup guarantee they require, capability discovery selects an eligible backend, and a test cannot pass when required cleanup remains unproven.

This design is limited to test process supervision. Portable atomic state and job publication hardening remains a separate concern. Production process-adapter hardening is a later work item and will not import the test controller wholesale.

## 2. Problem

Integration tests start brokers, workers, command shims, and deliberately adversarial descendants. Some descendants may:

- Outlive the process the test originally launched.
- Hold stdout or stderr pipes open after the root process exits.
- Detach into another process group or session.
- Exit before their identity can be queried.
- Reuse a previously recorded PID.
- Race with state publication, cancellation, or controller shutdown.

Waiting for the root process or killing a raw PID is therefore insufficient. The harness needs a trusted launch boundary, bounded output capture, explicit ownership, deterministic cleanup, and evidence that owned descendants are gone.

The current Windows-oriented work in progress addresses many of these cases, but it has three structural problems:

1. Windows implementation details occupy the shared helper and test surface.
2. Ordinary tests contain Windows gates instead of exercising a common contract.
3. Non-Windows cleanup is weaker and cannot honestly claim the same proof.

The solution must preserve the strong Windows work while extracting its portable contract and making platform guarantees explicit.

## 3. Goals

The design must provide:

1. One caller-facing API for Windows, Linux, and macOS.
2. Strict containment and kernel-backed drain proof on supported Windows and Linux hosts.
3. A useful cooperative native macOS mode with explicit limitations.
4. Fail-closed behavior when a test requests a guarantee the host cannot provide.
5. Ownership based on supervisor epochs, random nonces, and backend identity rather than raw PIDs.
6. Bounded stdout, stderr, protocol frames, and diagnostics.
7. Synchronous and asynchronous launch behavior compatible with the existing test suite.
8. A common contract suite that runs against every backend.
9. Isolation of native and platform-specific code from ordinary tests.
10. Preservation of all current uncommitted work until it is deliberately separated and migrated.
11. A Linux cleanup owner that survives coordinator and test-runner failure.

## 4. Non-goals

This design does not:

- Promise orphan-proof strict containment from native macOS process groups alone.
- Silently treat cooperative cleanup as equivalent to kernel containment.
- Require Docker, a VM, or another container runtime for ordinary local tests.
- Replace the production process adapter.
- Move the Windows test controller directly into production code.
- Expose a complete Node.js `ChildProcess` implementation; only a documented compatible subset is required.
- Combine portable state publication changes with supervisor extraction.
- Terminate unrelated processes based only on a stored PID.

## 5. Approved decisions

| Decision | Approved choice |
|---|---|
| Public surface | One platform-neutral test supervisor API |
| Windows backend | Job Object, strict |
| Linux backend | Protected cgroups v2 boundary with an independent host reaper, strict; pidfds and namespaces used where available |
| macOS backend | Cooperative process group plus registered descendants |
| Host-strict macOS | Explicit capability failure |
| External macOS proof | Outer orchestrator adjudicates only after disposable-runner destruction |
| Downgrade policy | Never silently downgrade strict to cooperative |
| Synchronous API | Retained for compatibility |
| Output ownership | Shared coordinator, bounded capture |
| Ownership identity | Opaque lease with epoch, run ID, nonce, and backend identity |
| Production adoption | Separate follow-on design and implementation |
| Current WIP | Preserved, then split by concern before migration |

## 6. Alternatives considered

### 6.1 Shared API with operating-system backends

This is the approved approach. It provides one caller contract while using each platform's strongest available primitive. Differences are expressed as capabilities rather than hidden inside tests.

The tradeoff is maintaining several small backends and a native Windows component. That complexity is justified because process containment is inherently platform-specific.

### 6.2 Process groups everywhere

A process-group-only implementation would be smaller. It is not sufficient for strict tests: descendants can create a new session, PID identity is weak, and process-group emptiness does not prove that every owned detached descendant is gone.

This approach remains useful as the basis of cooperative POSIX mode, but it is not a universal strict backend.

### 6.3 Containers or virtual machines everywhere

Disposable external environments can provide strong outer containment, but requiring them for every local test would make development slower and introduce Docker, virtualization, image, and Windows-container differences unrelated to the plugin.

External isolation is reserved for strict macOS release evidence and optional high-assurance CI jobs.

## 7. Capability and guarantee model

The supervisor exposes guarantees directly:

```js
{
  platform: "win32" | "linux" | "darwin",
  backend: "windows-job" | "linux-cgroup-v2" | "posix-cooperative",
  mode: "host-strict" | "cooperative",
  containment: "kernel" | "cooperative",
  cleanupProof: "kernel-drained" | "registered-drained",
  supportsDetachedDescendants: true | false
}
```

Launch policy accepts:

- `host-strict`: in-host kernel containment and drain proof are mandatory.
- `cooperative`: controlled fixtures may use the registration protocol and process groups.
- `auto`: select the strongest available mode allowed by the test's declared requirement.

`auto` does not mean unrestricted fallback. A test declares its minimum guarantee, and selection may only choose a backend that satisfies it.

If no eligible backend exists, launch fails before the target starts with `CAPABILITY_UNAVAILABLE`. The test runner records a capability skip only when the suite explicitly permits one; otherwise the missing capability is a failure.

External disposal is not an in-guest supervisor capability. Guarantee evaluation uses this partial order:

```text
cooperative < contained
host-strict satisfies contained
external-strict satisfies contained
host-strict and external-strict are distinct proofs
```

A test may require `cooperative`, `contained`, `host-strict`, or `external-strict`. The in-guest supervisor can satisfy only `cooperative` and `host-strict`. An external orchestrator may satisfy `external-strict` only after destroying the scoped environment and producing a nonce-bound disposal attestation. An environment variable, command-line flag, or in-guest capability claim is never sufficient.

## 8. Repository structure

The test supervisor will be extracted under the Codex Relay test tree:

```text
plugins/cdx-relay/tests/
├── helpers.mjs
└── process-supervisor/
    ├── index.mjs
    ├── coordinator.mjs
    ├── protocol.mjs
    ├── result.mjs
    ├── worker.mjs
    ├── launch-shim.mjs
    ├── backends/
    │   ├── windows.mjs
    │   ├── linux-cgroup.mjs
    │   ├── posix-process-group.mjs
    │   └── macos.mjs
    └── native/
        └── windows/
            ├── controller.cs
            └── controller.ps1
```

`helpers.mjs` retains stable convenience exports but delegates process lifecycle work to this directory. Ordinary tests do not import platform backends or inspect controller-specific fields.

The shared coordinator does not import application state. Tests that need cleanup of recorded broker or worker processes inject a `discoverRecordedProcesses(cwd)` callback. This keeps the supervisor reusable and prevents a test utility from acquiring hidden knowledge of the production state format.

## 9. Public API

The public factory is conceptually:

```js
const supervisor = await createProcessSupervisor({
  mode: "auto",
  minimumGuarantee: "cooperative",
  discoverRecordedProcesses
});
```

It exposes:

```js
supervisor.capabilities();

supervisor.run({
  command,
  args,
  cwd,
  env,
  input,
  timeoutMs,
  outputLimit
});

supervisor.spawnTracked({
  command,
  args,
  cwd,
  env,
  input,
  timeoutMs,
  outputLimit
});

await supervisor.cleanupAll();
await supervisor.shutdown();
```

The existing helper exports remain available during migration:

- `run(...)`
- `spawnTracked(...)`
- `trackChild(...)`
- `cleanupTrackedChildren(...)`
- `resolveTestCommand(...)`

`run` returns a spawnSync-shaped result including `status`, `signal`, `stdout`, `stderr`, `error`, and supervisor diagnostics. It may use a worker process internally so the shared coordinator can perform asynchronous setup and containment before exposing a synchronous result. A normal target failure remains a returned nonzero result, matching `spawnSync`. A supervisor, containment, or cleanup-proof failure throws `SupervisorInfrastructureError` with the structured terminal result attached; it can never be represented as an ordinary successful return.

`spawnTracked` returns a documented child-like handle supporting the subset used by the tests:

- `pid`
- `stdin`, `stdout`, and `stderr`
- `kill(signal)`
- `ref()` and `unref()`
- `exit`, `close`, and `error` events
- `completion`, a promise for the terminal structured result
- terminal exit metadata

The handle is not advertised as a complete Node.js `ChildProcess`. Tests that need unsupported members must use supervisor methods or extend the documented contract deliberately.

`exit` reports root-process exit. It does not prove descendant cleanup. The supervisor then initiates boundary cleanup, obtains the required proof, and finalizes output. `completion` resolves with the structured result for normal target completion, including normal nonzero target exits. It rejects with `SupervisorInfrastructureError` and an attached terminal result for supervisor, containment, or cleanup-proof failure. `close` is emitted after that settlement. Ordinary asynchronous tests must await `completion`; awaiting `exit` alone cannot produce a passing test. The terminal result distinguishes the requested cancellation signal, the root's observed signal, and the backend termination cause.

`kill(signal)` is an idempotent cancellation request and returns whether the request was accepted. A backend may map a requested signal to its safe containment primitive, but it must record that mapping rather than claiming the target observed a signal it did not observe.

`cleanupAll()` is asynchronous and idempotent. Concurrent calls share one cleanup operation. It resolves to `{ status, proofs }` only when every required proof succeeds; otherwise it rejects with `SupervisorCleanupError` containing `{ status, proofs, failures }`.

`shutdown()` first closes the supervisor to new launches, then completes `cleanupAll()` and stops backend infrastructure. It resolves with the proof summary plus backend shutdown evidence only when both phases succeed; otherwise it finishes every safe cleanup attempt and then rejects with the aggregate structured failure. Launch after shutdown begins fails with `SUPERVISOR_SHUTDOWN`.

Every infrastructure or cleanup failure also sets an irreversible failure latch on the supervisor instance. The package test fixture owns the supervisor and installs a mandatory suite-level teardown that awaits `shutdown()` and calls `assertHealthy()`. `assertHealthy()` throws the latched structured error even if an individual test ignored or mishandled an earlier rejected promise. This is an explicit test-runner fixture, not a process-global `beforeExit` hook.

`trackChild(...)` is a deprecated cooperative-only compatibility helper for already-running children. It can never satisfy `host-strict`, must reject use by a test that requires `host-strict`, and is removed after all callers migrate to `spawnTracked(...)`.

`discoverRecordedProcesses(cwd)` is diagnostic discovery, not process adoption. It returns bounded records such as `{ pid, processStartedAt, expectedExecutable, expectedArgv, sourceRecord }`. A discovered process is terminable only when it correlates to a live supervisor lease with matching epoch, nonce, and backend identity. An unmatched or stale live discovery produces `UNREGISTERED_RECORDED_PROCESS` and an infrastructure failure; it never authorizes PID-based termination.

## 10. Shared coordinator

The coordinator owns behavior that must be identical on every platform:

- Backend probing and selection.
- Supervisor epoch creation and invalidation.
- Run IDs and cryptographically random launch nonces.
- Lease registration and lifecycle.
- Trusted launch-shim handshake.
- Output capture, caps, truncation metadata, and digesting.
- Root exit and signal normalization.
- `exit` and `close` ordering for asynchronous handles.
- Timeout and cancellation policy.
- Cleanup orchestration and proof classification.
- Error normalization and bounded diagnostics.
- An irreversible infrastructure-failure latch consumed by mandatory suite teardown.

An opaque lease contains:

```text
supervisorEpoch
runId
launchNonce
backend
backendIdentity
rootIdentity
createdAt
state
```

Callers never use a PID as proof of ownership. A PID may be included for diagnostics, but termination requires the lease, matching epoch, nonce, and backend-specific identity.

If the control transport is corrupted, the controller reports contradictory identity, or cleanup becomes ambiguous, the coordinator poisons the supervisor epoch. All coordinator-facing leases from that epoch become untrusted, new launches are refused, and shutdown must resolve or report every remaining boundary. A backend fail-safe owner retains its independently authenticated boundary handle and cleanup authority even when the coordinator epoch is poisoned; it may terminate the complete boundary but may not launch, adopt, or target an individual PID. One bad channel cannot leave other leases appearing healthy or disable fail-safe cleanup.

## 11. Launch and cleanup data flow

Every launch follows this sequence:

1. Determine the minimum guarantee and select an eligible backend.
2. Create a supervisor epoch if necessary.
3. Create the run ID, random nonce, private control channel, and provisional lease.
4. Start the trusted launch shim in a blocked state.
5. Establish the backend containment boundary and its failure-surviving owner.
6. Bind the shim to that boundary and validate its identity.
7. Authorize the shim to start the target.
8. Register root identity and transition the lease to `running`.
9. Drain bounded stdout, stderr, and control messages continuously.
10. Record root completion independently of descendant completion.
11. On normal cleanup, cancellation, timeout, or harness shutdown, terminate the owned boundary.
12. Wait for backend-specific drain proof.
13. Close output streams, publish the terminal result, resolve or reject `completion`, emit `close`, and only then clear the lease.

A fast-exiting root cannot bypass identity validation because the trusted shim completes the private nonce handshake before target release. Historical backend events may strengthen diagnostics, but they are not the sole proof that an already exited target belonged to the launch.

A test cannot pass solely because its root process returned success. Required cleanup must also finish with an acceptable proof level. `unproven`, `transport-lost`, `identity-mismatch`, or `protocol-lost` cleanup rejects or throws immediately and latches the suite supervisor as failed.

## 12. Output and result contract

The coordinator owns all output buffering so backends cannot drift semantically.

Each stream has configurable and global byte caps. A result records:

- Bounded retained bytes.
- Total observed byte count.
- Whether output was truncated.
- A digest of the complete observed stream where feasible.
- Framing or decoding errors.
- Root exit code, signal, and cause.
- Backend and guarantee mode.
- Root diagnostic PID plus creation identity and nonce binding.
- Cleanup action and proof.
- Timing for launch, root exit, cleanup start, and drain completion.

The coordinator does not wait forever for stdout or stderr EOF when a descendant inherits a pipe. Root completion and boundary drain are separate facts. Cleanup closes the owned boundary, waits for the appropriate drain proof, then finalizes streams under a bounded deadline.

Controller protocol frames, output chunks, error messages, and metadata are all length-bounded before allocation. Oversized or malformed frames poison the affected supervisor epoch.

## 13. Windows strict backend

The Windows backend extracts the proven Job Object mechanism from the current work in progress while keeping only containment, launch, termination, identity, and drain responsibilities.

It uses:

- A Job Object with kill-on-job-close behavior.
- A suspended or blocked trusted shim.
- Assignment to the Job Object before target release.
- A private nonce-bound controller channel.
- Job completion notifications for membership history and diagnostics.
- Active-process count reaching zero as kernel drain proof.

The backend reports `kernel-drained` only after the Job Object proves no active process remains. Controller exit without this proof is a cleanup failure.

PowerShell and `Add-Type` availability are capability-probed and isolated inside the backend. Their absence produces `CAPABILITY_UNAVAILABLE`, not an untracked fallback. Replacing the bootstrap with a compiled Rust or other sidecar may be considered later, but it is not required for the initial portable extraction.

## 14. Linux strict backend

The Linux strict backend uses cgroups v2, but writable delegation alone is not sufficient. A process may migrate within a subtree it can control, so an emptied leaf cgroup cannot prove containment if the payload can write to its parent or a sibling.

`host-strict` is available only when the backend can establish all of these conditions:

1. An independent host reaper owns a per-run outer cgroup and remains outside the payload boundary.
2. The reaper is outside the payload's signal and process-visibility trust domain, using a separate service identity, PID namespace, or equivalent runner isolation.
3. The payload starts in a leaf beneath the per-run outer cgroup before executing user code.
4. The payload has no writable view of cgroup migration controls. A mount namespace, permissions boundary, or stronger host facility prevents writes to the run cgroup, delegated parent, or siblings.
5. The reaper retains an authenticated run handle and durable bounded registry that the Node coordinator cannot forge or revoke.
6. The reaper watches the harness through a pidfd or an equivalently race-resistant lifetime signal.

Launch sequence:

1. Probe for cgroups v2, required controllers, reaper availability, and the namespace or permissions boundary.
2. Ask the reaper to create the protected per-run outer cgroup and payload leaf.
3. Create a nonce-bound durable run record owned by the reaper.
4. Start the trusted shim blocked inside the payload leaf.
5. Validate cgroup membership, namespace restrictions, and shim identity.
6. Release the target.

Where pidfds are available, the backend uses them for root and harness identity and waiting. Pidfds supplement the cgroup; they do not replace descendant containment.

Normal cleanup asks the reaper to write `cgroup.kill` to the per-run outer cgroup, then wait until that outer cgroup's `cgroup.events` reports `populated 0`. Only then may it report `kernel-drained` and remove the subtree.

If the Node worker, coordinator, or test runner exits, its authenticated channel closes or its watched identity terminates. The independent reaper then performs the same kill-and-drain sequence without relying on a coordinator lease. On reaper startup, stale run records and subtrees are reconciled and drained before new strict launches are accepted.

If any prerequisite is unavailable, `host-strict` fails with `CAPABILITY_UNAVAILABLE`. A merely writable delegated subtree is never advertised as strict. `auto` may select cooperative mode only when the test's minimum guarantee permits it.

## 15. POSIX cooperative backend

The cooperative backend is shared by Linux fallback and macOS, with a small macOS adapter for capability reporting and process identity inspection.

It uses:

- A new process group or session rooted at the trusted launch shim.
- A private supervisor token containing run ID and nonce.
- Registration of controlled descendants.
- Process identity checks available on the host.
- Group termination followed by validation of all registered descendants.

Repository-controlled broker and worker spawn seams must propagate the supervisor token. While cooperative mode is active, they must not detach into an unregistered session or process group. Each controlled descendant registers before it can perform durable work.

Cleanup terminates the root process group, validates and terminates registered descendants when necessary, and reports `registered-drained` only when the registry is empty and identities match. Loss of the registration protocol, discovery of an unregistered controlled descendant, or identity ambiguity is an infrastructure failure.

This backend is useful for functional coverage and controlled fixtures. It cannot prove that arbitrary hostile code did not escape, so it never reports kernel containment.

## 16. macOS policy

Native macOS runs the common functional suite in cooperative mode.

A test that requires `host-strict` orphan-proof containment receives `CAPABILITY_UNAVAILABLE` on a normal macOS host. The supervisor does not relabel process-group cleanup as strict.

Release workflows that require strict macOS evidence use an outer orchestrator to create a disposable native macOS runner or VM. The orchestrator generates a runner identity, environment identity, and random run nonce; the in-guest test records the scoped token and returns only a provisional cooperative result marked `pending-external-disposal`.

After receiving the provisional result, the orchestrator destroys the complete environment and verifies disposal. Only the outer orchestrator can then issue the nonce-bound `external-strict` verdict. If the guest result is lost, the nonce does not match, disposal fails, or disposal cannot be verified, the strict gate fails. The in-guest supervisor never reports `external-disposal` and cannot enable it through an environment flag.

## 17. Error handling

The supervisor normalizes infrastructure failures:

| Code | Meaning |
|---|---|
| `CAPABILITY_UNAVAILABLE` | The requested guarantee is not supported by this host. |
| `SUPERVISOR_POISONED` | The current supervisor epoch cannot be trusted. |
| `LAUNCH_HANDSHAKE_FAILED` | The trusted shim or nonce handshake did not complete. |
| `IDENTITY_MISMATCH` | Backend or process identity did not match the lease. |
| `PROTOCOL_LOST` | Cooperative descendant registration or control transport was lost. |
| `OUTPUT_LIMIT_EXCEEDED` | A hard protocol or diagnostic limit was exceeded. |
| `CLEANUP_UNPROVEN` | Termination was attempted but the required drain proof was not obtained. |
| `CLEANUP_TIMED_OUT` | The owned boundary did not drain within the cleanup deadline. |
| `STALE_LEASE` | An operation referenced another supervisor epoch or an invalid lease. |
| `UNREGISTERED_RECORDED_PROCESS` | Durable state names a live process with no matching supervisor lease. |
| `SUPERVISOR_SHUTDOWN` | A launch was attempted after shutdown began. |

Cleanup errors fail the test even if the target result was otherwise successful. They reject or throw through the active operation and set the irreversible suite failure latch, which mandatory teardown checks independently. Diagnostic ownership is retained until the backend confirms shutdown or the external runner is disposed.

No backend may issue raw PID termination without validating the lease and the strongest available process identity. A fail-safe backend owner may terminate its complete authenticated containment boundary without trusting the poisoned coordinator lease, but it may not select an individual process from a raw PID. On uncertainty the supervisor fails closed and reports the unresolved boundary.

## 18. Security and robustness

The control design uses:

- Private channels scoped to one user and one run.
- Cryptographically random nonces.
- Restricted temporary-directory permissions.
- Length-prefixed, size-bounded protocol messages.
- Explicit protocol versions.
- Epoch invalidation after transport corruption.
- Argument-array spawning instead of shell-built commands.
- Identity validation before termination.
- Bounded setup, execution, output-drain, cleanup, and shutdown deadlines.

The trusted shim is deliberately small. It validates the initial nonce, waits for containment authorization, launches the exact argument array, reports target identity, and forwards lifecycle data. It does not contain test assertions or application-state logic.

## 19. Testing strategy

### 19.1 Common contract suite

Every backend runs the same tests for:

- Capability reporting and selection.
- Synchronous result shape.
- Asynchronous child-like lifecycle.
- `exit`, `close`, and `error` ordering.
- `ref()` and `unref()`.
- Exit codes and signals.
- Input and environment propagation.
- Paths with spaces and Unicode.
- Bounded large stdout and stderr.
- Root exit while descendants retain pipes.
- Cancellation and timeout escalation.
- Controller or worker crash.
- Stale lease and epoch rejection.
- Malformed and oversized protocol frames.
- Cleanup proof gating.

Ordinary contract tests contain no Windows-only helper names or backend field assertions.

### 19.2 Backend adversarial suites

Windows strict tests cover:

- Descendant detachment attempts.
- Fast target exit.
- PID reuse defenses.
- Job controller failure.
- Large chunked output.
- Completion history and active-process-zero proof.

Linux strict tests cover:

- Descendant session detachment inside the cgroup.
- Attempts to migrate into the delegated parent, outer run cgroup, and sibling cgroups.
- Attempts to remount or write cgroup migration controls.
- Attempts to signal or terminate the independent reaper.
- Fast target exit.
- cgroup controller failure.
- Coordinator, Node worker, and test-runner death with fail-safe reaping.
- Reaper restart and stale-subtree recovery.
- `cgroup.kill`.
- `populated 0` proof and cgroup removal.
- Missing delegation, missing isolation prerequisites, and explicit strict refusal.

POSIX and macOS cooperative tests cover:

- Process-group cleanup.
- Registration propagation through broker and worker fixtures.
- Protocol loss.
- Unregistered controlled descendants.
- Identity mismatch.
- Explicit refusal of strict mode.

### 19.3 CI matrix

The required matrix is:

| Platform | Required evidence |
|---|---|
| Windows | Common suite plus Windows strict adversarial suite |
| Linux with protected cgroups v2 and an independent reaper | Common suite plus Linux strict adversarial suite |
| macOS | Common functional suite in cooperative mode plus strict-refusal tests |
| Disposable native macOS runner, when release policy requires it | Orchestrator-issued, nonce-bound external-strict disposal evidence |

The existing 600-second package aggregate and root gates run only after portable integration and focused backend gates are green. Extending the timeout is not a substitute for unresolved cleanup, identity, or protocol failures.

## 20. Migration sequence

Implementation will proceed in reviewable stages:

1. Preserve the current worktree and inventory every tracked and untracked change.
2. Separate portable atomic state and job publication hardening into its own commit and verification.
3. Add contract tests for the current helper surface before changing behavior.
4. Extract the platform-neutral coordinator, result normalization, protocol, and worker bridge.
5. Move the Windows controller and native bootstrap behind the backend interface.
6. Restore the approved Windows strict behavior through the common contract.
7. Implement the Linux protected-cgroup strict backend, independent reaper, recovery path, and capability probe.
8. Implement the POSIX/macOS cooperative backend and descendant-registration seam.
9. Convert every `trackChild(...)` caller to `spawnTracked(...)`, then remove the compatibility export.
10. Convert generic tests away from Windows skips and platform-specific assertions.
11. Remove Windows-specific names and implementation details from `helpers.mjs` and ordinary callers.
12. Run focused contract, backend, package aggregate, and root verification.
13. Address production process-adapter portability in a separate follow-on design.

Each stage follows test-driven development and receives implementation review before the next stage. Shared files are not edited concurrently by multiple agents.

## 21. WIP preservation and commit boundaries

The current worktree contains substantial uncommitted Windows supervisor and state-publication work. It is evidence and implementation material, not disposable scaffolding.

Before extraction:

- No existing tracked modification is reset or overwritten.
- All untracked native files are inventoried.
- State publication changes are separated from process-supervisor changes.
- The Windows containment core is migrated mechanically before it is simplified.
- Public behavior is pinned by tests.
- Intermediate commits contain one concern and remain reviewable.

The design document itself is committed alone. It does not stage or commit any implementation WIP.

## 22. Acceptance criteria

The portable supervisor is complete only when:

1. Ordinary tests call one platform-neutral helper surface.
2. Platform-specific implementation is isolated under backend directories.
3. Windows strict tests prove Job Object drain with zero surviving owned processes.
4. Linux strict tests prove that the payload cannot migrate outside its protected run boundary and that the independent reaper drains the outer cgroup to `populated 0`, including after coordinator and test-runner failure.
5. Native macOS runs the common suite in cooperative mode.
6. Native macOS `host-strict` fails explicitly; external strict evidence is issued only by the outer orchestrator after verified environment disposal.
7. No strict request silently falls back to cooperative cleanup.
8. Root success cannot hide unproven cleanup.
9. Ownership and termination never rely on a raw PID alone.
10. Fast-exit, PID-reuse, inherited-pipe, controller-crash, large-output, and protocol-corruption cases pass their backend gates.
11. `trackChild(...)` has no remaining callers and is removed; every supervised launch enters its boundary before target execution.
12. Generic tests no longer need Windows-only skips except tests that deliberately exercise the Windows backend.
13. `helpers.mjs` is reduced to shared test utilities and compatibility wrappers.
14. Atomic state publication hardening remains independently testable and reviewable.
15. The package aggregate completes within the approved 600-second gate.
16. The root suite passes with real reported counts and no surviving supervised processes.
17. A high-reasoning verification review reports no unresolved correctness or portability findings.
18. Supervisor and cleanup failures throw or reject, latch the suite supervisor as failed, and are rethrown by mandatory suite teardown even if a test ignores an earlier failure.

## 23. Approval and implementation boundary

This document fixes the portable supervisor architecture. It does not authorize implementation by itself.

After the user reviews and approves this written specification, the next step is a separate detailed implementation plan produced through the writing-plans workflow. Implementation begins only after that plan is reviewed and approved.
