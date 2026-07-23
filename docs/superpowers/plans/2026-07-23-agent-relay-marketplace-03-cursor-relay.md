# Cursor Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Cursor Relay 1.0.0 as a self-contained Claude Code plugin using the authenticated local Cursor Agent CLI with safe delegation, resume, cancellation, and enforced read-only review.

**Architecture:** A Node.js ESM controller wraps the Cursor CLI through a Windows-aware launcher and structured-stream transport. Cursor Relay owns its commands, configuration, state, leases, snapshots, errors, process handling, tests, and optional non-blocking notifications. It copies contract schemas at build time but imports no root or Codex runtime.

**Tech Stack:** Node.js ESM 20+, Cursor Agent CLI `2026.07.20-8cc9c0b` compatibility baseline, `composer-2.5` default model, Node built-in tests, Apache-2.0.

## Global Constraints

- Depends on the completed foundation plan.
- Target plugin identity/version: `cursor-relay` 1.0.0.
- Display name: `Cursor Relay`.
- V1 transport: authenticated local Cursor Agent CLI only.
- Default model: `composer-2.5`; validate it from the live model list.
- No Cursor SDK, cloud agents, API keys, or SDK token billing.
- Never default to `--force`, `--yolo`, `--trust`, disabled sandboxing, or `--approve-mcps`.
- Workspace trust remains provider-native.
- Cursor review ships only if the full native Windows read-only gate passes.
- No blocking Stop hook.
- State lives only under Cursor Relay’s `${CLAUDE_PLUGIN_DATA}`.
- Runtime cannot import root or Codex files.
- Use argument-array spawning. On Windows, bypass the PowerShell launcher by resolving its bundled `node.exe` and `index.js`.
- Native Windows tests are release-blocking.

---

## File map

| Path | Responsibility |
|---|---|
| `plugins/cursor-relay/.claude-plugin/plugin.json` | Plugin identity, version, license |
| `plugins/cursor-relay/commands/*.md` | Common commands and guarded review |
| `plugins/cursor-relay/hooks/hooks.json` | Non-blocking provider-scoped hooks only |
| `plugins/cursor-relay/scripts/cursor-relay.mjs` | CLI entrypoint |
| `plugins/cursor-relay/scripts/worker.mjs` | Detached background worker |
| `plugins/cursor-relay/scripts/relay-controller.mjs` | Preflight, launch, stream, terminalization |
| `plugins/cursor-relay/scripts/lib/cursor-launcher.mjs` | Native executable/Windows bundle resolution |
| `plugins/cursor-relay/scripts/lib/cursor-transport.mjs` | CLI arguments, JSONL stream, resume, graceful stop |
| `plugins/cursor-relay/scripts/lib/stream-parser.mjs` | Tolerant structured event parsing |
| `plugins/cursor-relay/scripts/lib/job-store.mjs` | Cursor-local per-job persistence |
| `plugins/cursor-relay/scripts/lib/atomic-json.mjs` | Atomic writes and corruption quarantine |
| `plugins/cursor-relay/scripts/lib/contracts.mjs` | Cursor-local runtime validation |
| `plugins/cursor-relay/scripts/lib/workspace-lease.mjs` | Neutral lease protocol implementation |
| `plugins/cursor-relay/scripts/lib/workspace-snapshot.mjs` | Baseline/final delta and review no-write check |
| `plugins/cursor-relay/scripts/lib/process.mjs` | Process identity and Windows tree termination |
| `plugins/cursor-relay/scripts/lib/relay-errors.mjs` | Stable errors and retry safety |
| `plugins/cursor-relay/scripts/lib/render.mjs` | Human receipt/status/result rendering |
| `plugins/cursor-relay/tests/fake-cursor.mjs` | Deterministic Cursor CLI fixture |
| `plugins/cursor-relay/tests/*.test.mjs` | Plugin-local tests |

### Task 1: Create the isolated plugin and command contract

**Files:**
- Create: `plugins/cursor-relay/.claude-plugin/plugin.json`
- Create: `plugins/cursor-relay/package.json`
- Create: `plugins/cursor-relay/LICENSE`
- Create: `plugins/cursor-relay/NOTICE`
- Create: `plugins/cursor-relay/PROVENANCE.md`
- Create: `plugins/cursor-relay/CHANGELOG.md`
- Create: `plugins/cursor-relay/commands/delegate.md`
- Create: `plugins/cursor-relay/commands/status.md`
- Create: `plugins/cursor-relay/commands/result.md`
- Create: `plugins/cursor-relay/commands/cancel.md`
- Create: `plugins/cursor-relay/commands/resume.md`
- Create: `plugins/cursor-relay/commands/doctor.md`
- Create: `plugins/cursor-relay/commands/setup.md`
- Create: `plugins/cursor-relay/tests/manifest.test.mjs`

**Interfaces:**
- Consumes: common command names from the approved spec.
- Produces: a valid, self-contained plugin manifest and seven deterministic command entrypoints.

- [ ] **Step 1: Write the failing manifest test**

Create `plugins/cursor-relay/tests/manifest.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Cursor Relay manifest and command namespace are exact", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "cursor-relay");
  assert.equal(manifest.displayName, "Cursor Relay");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.license, "Apache-2.0");
  for (const name of ["delegate", "status", "result", "cancel", "resume", "doctor", "setup"]) {
    const source = fs.readFileSync(path.join(pluginRoot, "commands", `${name}.md`), "utf8");
    assert.match(source, /CLAUDE_PLUGIN_ROOT/);
    assert.doesNotMatch(source, /agent-relay:/);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test plugins/cursor-relay/tests/manifest.test.mjs
```

Expected: non-zero exit with `ENOENT` for the plugin manifest.

- [ ] **Step 3: Add manifest, package, license, and provenance**

Create `plugins/cursor-relay/.claude-plugin/plugin.json`:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "cursor-relay",
  "displayName": "Cursor Relay",
  "version": "1.0.0",
  "description": "Delegate Claude Code tasks and reviews to the authenticated local Cursor Agent CLI.",
  "author": {
    "name": "hotaru-ritsuki"
  },
  "license": "Apache-2.0",
  "repository": "https://github.com/hotaru-ritsuki/agent-relay-marketplace"
}
```

Create `plugins/cursor-relay/package.json`:

```json
{
  "name": "@hotaru-ritsuki/cursor-relay",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "license": "Apache-2.0",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "test": "node --test --test-timeout=30000 tests/*.test.mjs"
  }
}
```

Copy root `LICENSE` into the plugin. `NOTICE` identifies this as a clean implementation and lists `freema/cursor-plugin-cc` as an MIT-licensed research reference only when copied code is present. `PROVENANCE.md` records inspected reference commit `740279775ffb0bf1c107127374ee31c4facd0045` and states that no code is copied by default.

- [ ] **Step 4: Add the seven command documents**

Each command invokes:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-relay.mjs" <command> --json "$ARGUMENTS"
```

Use these argument hints:

```text
delegate: <task> [--background] [--model <model>] [--allow-concurrent-writes]
status: [job-id] [--all]
result: <job-id>
cancel: <job-id>
resume: <job-id> [additional instructions]
doctor: no arguments
setup: [--model <model>] [--scope user|workspace]
```

Do not grant Bash wildcard access. Restrict each command to `Bash(node:*)`; `setup` may also use `AskUserQuestion`.

- [ ] **Step 5: Run the manifest test**

Run:

```powershell
node --test plugins/cursor-relay/tests/manifest.test.mjs
```

Expected: 1 test passes, 0 fail.

- [ ] **Step 6: Commit**

```powershell
git add plugins/cursor-relay
git commit -m "feat: scaffold isolated Cursor Relay plugin"
```

### Task 2: Implement native launcher discovery, doctor, and setup

**Files:**
- Create: `plugins/cursor-relay/scripts/cursor-relay.mjs`
- Create: `plugins/cursor-relay/scripts/lib/cursor-launcher.mjs`
- Create: `plugins/cursor-relay/scripts/lib/config.mjs`
- Create: `plugins/cursor-relay/scripts/lib/render.mjs`
- Create: `plugins/cursor-relay/tests/fake-cursor.mjs`
- Create: `plugins/cursor-relay/tests/doctor.test.mjs`

**Interfaces:**
- Produces: `resolveCursorInvocation`, `runCursor`, `inspectCursor`, `loadConfig`, `saveConfig`.
- `resolveCursorInvocation` returns `{ command, argsPrefix, env, source }`.

- [ ] **Step 1: Write failing Windows launcher and doctor tests**

Create a fixture directory with:

```text
cursor-agent/
└── versions/
    ├── 2026.07.19-old/
    │   ├── node.exe
    │   └── index.js
    └── 2026.07.20-08-00-00-8cc9c0b/
        ├── node.exe
        └── index.js
```

Add tests:

```js
test("Windows launcher selects the newest bundled node and index without PowerShell", () => {
  const invocation = resolveCursorInvocation({
    platform: "win32",
    env: { LOCALAPPDATA: fixtureLocalAppData }
  });
  assert.match(invocation.command, /2026\.07\.20-08-00-00-8cc9c0b[\\/]node\.exe$/);
  assert.match(invocation.argsPrefix[0], /2026\.07\.20-08-00-00-8cc9c0b[\\/]index\.js$/);
  assert.equal(invocation.env.CURSOR_INVOKED_AS, "cursor-agent");
  assert.doesNotMatch(invocation.command, /powershell/i);
});

test("doctor reports login, version, Standard model, and safety capabilities", async () => {
  const report = await inspectCursor({ runCursor: fakeReadyCursor });
  assert.equal(report.ready, true);
  assert.equal(report.defaultModel, "composer-2.5");
  assert.equal(report.capabilities.askMode, true);
  assert.equal(report.capabilities.sandbox, true);
  assert.equal(report.capabilities.streamJson, true);
  assert.equal(report.accountIdentifier, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test plugins/cursor-relay/tests/doctor.test.mjs
```

Expected: non-zero exit because the launcher module is absent.

- [ ] **Step 3: Implement Windows and POSIX invocation resolution**

On Windows:

1. Check `%LOCALAPPDATA%\cursor-agent\node.exe` plus `index.js`.
2. Otherwise enumerate `%LOCALAPPDATA%\cursor-agent\versions`.
3. Accept only version directory names matching the installed launcher’s date/build/hash format.
4. Sort parsed date and optional build time descending.
5. Return the selected `node.exe` with `index.js` as `argsPrefix`.

On non-Windows, resolve `cursor-agent` or `agent` from `PATH` without POSIX-only `which`. Use `fs.access` over `PATH` entries and spawn the resolved file directly.

`runCursor` calls:

```js
spawn(invocation.command, [...invocation.argsPrefix, ...args], {
  cwd,
  env: { ...process.env, ...invocation.env },
  shell: false,
  windowsHide: true,
  stdio
});
```

- [ ] **Step 4: Implement read-only doctor inspection**

`inspectCursor` executes bounded calls for:

- `status`
- `models`
- `--help`

It redacts account identifiers, verifies `composer-2.5`, and detects `--output-format`, `stream-json`, `--mode`, `ask`, `--sandbox`, `--resume`, and cancellation-relevant process support.

If the default model is absent, return `CAPABILITY_UNAVAILABLE`; do not substitute a different model silently.

- [ ] **Step 5: Implement provider-local configuration**

`config.mjs` stores no credentials. It supports:

```js
{
  schemaVersion: 1,
  defaultModel: "composer-2.5",
  defaultBackground: false,
  timeoutMs: 900000,
  diagnosticCapture: false
}
```

User-scope config lives at `${CLAUDE_PLUGIN_DATA}/config.json`; workspace overrides live inside this plugin’s workspace state. Use atomic replacement.

- [ ] **Step 6: Wire `doctor` and `setup`**

`cursor-relay.mjs doctor --json` prints structured inspection without changing state.

`setup` validates supplied model against the live model list, writes only the selected scope, and reports native login/trust actions without performing them.

- [ ] **Step 7: Run doctor tests**

Run:

```powershell
node --test plugins/cursor-relay/tests/doctor.test.mjs
```

Expected: all tests pass with 0 failures.

- [ ] **Step 8: Commit**

```powershell
git add plugins/cursor-relay
git commit -m "feat: add Cursor CLI doctor and setup"
```

### Task 3: Implement Cursor-local contracts, jobs, leases, and errors

**Files:**
- Create: `plugins/cursor-relay/scripts/lib/atomic-json.mjs`
- Create: `plugins/cursor-relay/scripts/lib/contracts.mjs`
- Create: `plugins/cursor-relay/scripts/lib/job-store.mjs`
- Create: `plugins/cursor-relay/scripts/lib/relay-errors.mjs`
- Create: `plugins/cursor-relay/scripts/lib/workspace-lease.mjs`
- Create: `plugins/cursor-relay/scripts/lib/workspace-snapshot.mjs`
- Create: `plugins/cursor-relay/tests/state.test.mjs`
- Create: `plugins/cursor-relay/tests/lease.test.mjs`

**Interfaces:**
- Produces the same conceptual job/result/lease contracts as Codex, implemented entirely inside Cursor Relay.
- Job store methods: `create`, `transition`, `appendEvent`, `complete`, `read`, `list`, `prune`.

- [ ] **Step 1: Synchronize contract artifacts and write failing tests**

Run:

```powershell
node tooling/sync-contracts.mjs
```

Write tests that validate:

- Per-job directory layout.
- Atomic terminalization exactly once.
- Corrupt-state quarantine.
- 30-day/200-job pruning without deleting active jobs.
- Active Codex lease blocks Cursor mutation.
- Stale invalid lease is recoverable.
- `RelayError` redacts provider detail and carries retry safety.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test plugins/cursor-relay/tests/state.test.mjs plugins/cursor-relay/tests/lease.test.mjs
```

Expected: non-zero exit because state and lease modules are absent.

- [ ] **Step 3: Implement independent atomic state and validation**

Implement the same field names and transition rules defined by synchronized v1 schemas. Do not copy/import Codex runtime modules. Use temp-file flush, bounded Windows rename retry, owner-token locks, quarantine, append-only events, and compare-and-set terminalization.

- [ ] **Step 4: Implement the neutral workspace lease**

Use the approved lease schema under:

- Git common metadata for Git workspaces.
- `%TEMP%\agent-relay-leases\<workspace-hash>` or the corresponding OS temp root for non-Git workspaces.

Validate PID, creation time, nonce, and expiry. `--allow-concurrent-writes` bypasses acquisition only after recording the override in the job.

- [ ] **Step 5: Implement snapshots and errors**

Git snapshots use porcelain-v2 status and diff hashes. Non-Git snapshots use a bounded file inventory with size, mtime, and changed-candidate content hashes. Exclude VCS metadata, dependency caches, plugin state, and logs.

Use the exact approved error codes; no provider stderr reaches user output without redaction.

- [ ] **Step 6: Run contract/state/lease tests**

Run:

```powershell
node --test tests/contract/schemas.test.mjs plugins/cursor-relay/tests/state.test.mjs plugins/cursor-relay/tests/lease.test.mjs
```

Expected: all selected tests pass with 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add plugins/cursor-relay contracts
git commit -m "feat: add Cursor relay job and lease state"
```

### Task 4: Implement the structured Cursor CLI transport

**Files:**
- Create: `plugins/cursor-relay/scripts/lib/stream-parser.mjs`
- Create: `plugins/cursor-relay/scripts/lib/cursor-transport.mjs`
- Create: `plugins/cursor-relay/tests/fixtures/stream-success.jsonl`
- Create: `plugins/cursor-relay/tests/fixtures/stream-tool-call.jsonl`
- Create: `plugins/cursor-relay/tests/fixtures/stream-malformed.jsonl`
- Create: `plugins/cursor-relay/tests/transport.test.mjs`

**Interfaces:**
- Produces: `parseCursorEvent(line)`, `createCursorTransport({ invocation, spawnImpl })`.
- Transport methods: `detect`, `start`, `stream`, `resume`, `interrupt`, `dispose`.

- [ ] **Step 1: Write failing parser and argument tests**

Test:

```js
test("delegate arguments select explicit structured output and Standard model", () => {
  const transport = createFixtureTransport();
  const args = transport.buildStartArgs({ prompt: "Inspect the bug", model: "composer-2.5", readOnly: false });
  assert.deepEqual(args.slice(0, 6), [
    "-p", "Inspect the bug",
    "--model", "composer-2.5",
    "--output-format", "stream-json"
  ]);
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--trust"), false);
  assert.equal(args.includes("--approve-mcps"), false);
});

test("parser preserves unknown provider events", () => {
  const event = parseCursorEvent('{"type":"new-event","payload":{"x":1}}');
  assert.equal(event.kind, "provider");
  assert.equal(event.raw.type, "new-event");
});

test("malformed stream lines become bounded transport errors", () => {
  assert.throws(() => parseCursorEvent("{broken"), (error) => error.code === "TRANSPORT_FAILURE");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test plugins/cursor-relay/tests/transport.test.mjs
```

Expected: non-zero exit because transport modules are absent.

- [ ] **Step 3: Add recorded fixtures and tolerant parsing**

Fixtures contain system, assistant text, tool call, result, and unknown events with no account identifiers. `parseCursorEvent` returns:

```js
{
  kind: "assistant" | "tool" | "result" | "provider",
  text: string | null,
  sessionId: string | null,
  raw: object
}
```

Invalid JSON throws `TRANSPORT_FAILURE` with the line truncated to 200 redacted characters.

- [ ] **Step 4: Implement start, stream, and resume**

Start arguments include explicit prompt, model, `--output-format stream-json`, sandbox mode, and workspace. Add partial-output streaming only when detected by doctor.

Resume uses the exact stored provider session ID:

```text
resume <session-id> -p <additional instructions> --output-format stream-json
```

No cloud or SDK option exists.

- [ ] **Step 5: Implement graceful interrupt and dispose**

Interrupt closes stdin when supported, sends the platform’s graceful signal, waits a bounded period, and delegates final process-tree termination to `process.mjs`. It never marks cancellation confirmed solely because a signal was sent.

- [ ] **Step 6: Run transport tests**

Run:

```powershell
node --test plugins/cursor-relay/tests/transport.test.mjs
```

Expected: all tests pass with 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add plugins/cursor-relay
git commit -m "feat: add Cursor CLI streaming transport"
```

### Task 5: Implement foreground/background jobs and common commands

**Files:**
- Create: `plugins/cursor-relay/scripts/relay-controller.mjs`
- Create: `plugins/cursor-relay/scripts/worker.mjs`
- Create: `plugins/cursor-relay/scripts/lib/process.mjs`
- Create: `plugins/cursor-relay/tests/controller.test.mjs`
- Create: `plugins/cursor-relay/tests/process.test.mjs`
- Modify: `plugins/cursor-relay/scripts/cursor-relay.mjs`
- Modify: `plugins/cursor-relay/scripts/lib/render.mjs`

**Interfaces:**
- Produces: `runDelegate`, `runStatus`, `runResult`, `runCancel`, `runResume`.
- Process methods: `spawnTracked`, `requestGracefulStop`, `terminateVerifiedTree`, `isSameProcess`.

- [ ] **Step 1: Write failing controller tests**

Cover:

```js
test("foreground delegate terminalizes a completed result", async () => {
  const result = await runDelegate(fixture({ background: false }));
  assert.equal(result.status, "completed");
  assert.equal(result.provider, "cursor");
  assert.equal(result.transport, "cursor-cli");
});

test("background delegate returns a durable explicit-ID receipt", async () => {
  const receipt = await runDelegate(fixture({ background: true }));
  assert.equal(receipt.status, "starting");
  assert.match(receipt.text, new RegExp(`/cursor-relay:status ${receipt.jobId}`));
  assert.match(receipt.text, new RegExp(`/cursor-relay:result ${receipt.jobId}`));
  assert.match(receipt.text, new RegExp(`/cursor-relay:cancel ${receipt.jobId}`));
});

test("result and cancel reject missing job IDs", () => {
  assert.throws(() => runResult({ argv: [] }), /INVALID_REQUEST/);
  assert.throws(() => runCancel({ argv: [] }), /INVALID_REQUEST/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test plugins/cursor-relay/tests/controller.test.mjs plugins/cursor-relay/tests/process.test.mjs
```

Expected: non-zero exit because controller/process modules are absent.

- [ ] **Step 3: Implement the deterministic controller pipeline**

Implement:

1. Parse.
2. Preflight.
3. Snapshot.
4. Lease.
5. Durable `queued`.
6. Fixed transport/model/safety.
7. Launch.
8. Stream and persist.
9. Final snapshot.
10. Exactly-once terminalization.
11. Lease release.
12. Receipt/result rendering.

Background mode spawns `worker.mjs` with a job request file inside Cursor Relay state. The worker writes its own process identity before provider launch.

- [ ] **Step 4: Implement status, result, cancellation, and resume**

- `status` defaults to the current Claude session and accepts `--all`.
- `result` and `cancel` require exact job IDs.
- `cancel` records requested, provider interrupt attempted, provider confirmed, and local termination stages.
- `resume` creates a child job with `resumedFromJobId` and exact Cursor session ID.

- [ ] **Step 5: Implement Windows process-tree handling**

On Windows, store PID, creation time, and nonce. Implement `queryWindowsProcessStartedAt(pid, execFileSyncImpl)` with a fixed PowerShell script and the PID as a separate numeric argument:

```js
const script = [
  "param([int]$TargetPid)",
  "$p = Get-CimInstance Win32_Process -Filter (\"ProcessId = {0}\" -f $TargetPid)",
  "if ($null -eq $p) { exit 3 }",
  "$p.CreationDate.ToUniversalTime().ToString('o')"
].join("; ");

const startedAt = execFileSyncImpl(
  "pwsh",
  ["-NoProfile", "-NonInteractive", "-Command", script, String(pid)],
  { encoding: "utf8", windowsHide: true, timeout: 5000 }
).trim();
```

Reject non-positive or non-integer PIDs before invoking PowerShell. Validate the returned ISO timestamp and stored nonce before:

```text
taskkill /PID <pid> /T /F
```

Treat “process not found” as already stopped; do not treat access denied as success.

- [ ] **Step 6: Run controller and process tests**

Run:

```powershell
node --test plugins/cursor-relay/tests/controller.test.mjs plugins/cursor-relay/tests/process.test.mjs
```

Expected: all selected tests pass with 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add plugins/cursor-relay
git commit -m "feat: add Cursor relay job control"
```

### Task 6: Implement and prove enforced read-only review

**Files:**
- Create: `plugins/cursor-relay/commands/review.md`
- Create: `plugins/cursor-relay/tests/review.test.mjs`
- Create: `plugins/cursor-relay/tests/fixtures/review-write-attempt.jsonl`
- Modify: `plugins/cursor-relay/scripts/lib/cursor-transport.mjs`
- Modify: `plugins/cursor-relay/scripts/relay-controller.mjs`

**Interfaces:**
- Produces: `runReview`.
- Requires doctor capabilities: `askMode`, `sandbox`, `streamJson`.

- [ ] **Step 1: Write failing review safety tests**

Test:

```js
test("review uses ask mode, enabled sandbox, and structured output", () => {
  const args = buildReviewArgs({ prompt: "Review the current diff", model: "composer-2.5" });
  assert.ok(args.includes("--mode"));
  assert.ok(args.includes("ask"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("enabled"));
  assert.ok(args.includes("stream-json"));
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--trust"), false);
});

test("review fails closed when a write is observed", async () => {
  const result = await runReview(reviewFixtureThatWrites);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "SAFETY_POLICY_REJECTED");
  assert.deepEqual(result.changedFiles, ["attempted-write.txt"]);
});

test("review is unavailable when ask mode or sandbox capability is missing", async () => {
  await assert.rejects(
    runReview(fixture({ capabilities: { askMode: false, sandbox: true } })),
    (error) => error.code === "CAPABILITY_UNAVAILABLE"
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test plugins/cursor-relay/tests/review.test.mjs
```

Expected: non-zero exit because review is absent.

- [ ] **Step 3: Implement review transport policy**

Review always sets:

```text
--mode ask
--sandbox enabled
--model composer-2.5
--output-format stream-json
```

It refuses concurrent-write override, network elevation, force/yolo, trust grant, and MCP auto-approval. It captures a baseline and final snapshot regardless of provider outcome.

- [ ] **Step 4: Implement fail-closed result handling**

Any observed write produces `SAFETY_POLICY_REJECTED`, preserves the provider output for diagnostics, reports changed paths, and never repairs or deletes the write automatically.

Missing capability or unsupported CLI version omits successful review behavior; `doctor` reports the exact requirement.

- [ ] **Step 5: Run unit and native Windows review gates**

Run:

```powershell
node --test plugins/cursor-relay/tests/review.test.mjs
node plugins/cursor-relay/scripts/cursor-relay.mjs doctor --json
```

Expected: unit tests pass; doctor reports `askMode`, `sandbox`, and `streamJson` true for the supported local Cursor CLI. Then run a disposable-workspace read-only smoke prompt that attempts a write. Expected: the sandbox prevents the write or the plugin returns `SAFETY_POLICY_REJECTED`; no write may be reported as a successful review.

Immediately before the disposable live prompt, request user approval because the command consumes Cursor plan usage. Without approval, record unit/doctor evidence and leave the paid live gate pending; do not commit the exposed review command.

- [ ] **Step 6: Commit**

Commit only when the native Windows gate passes:

```powershell
git add plugins/cursor-relay
git commit -m "feat: add enforced Cursor read-only review"
```

If the native gate fails, stop this task, leave `commands/review.md` uncommitted, and request a design revision. Do not weaken the gate.

### Task 7: Add non-blocking hooks, retention, and release metadata

**Files:**
- Create: `plugins/cursor-relay/hooks/hooks.json`
- Create: `plugins/cursor-relay/scripts/session-lifecycle-hook.mjs`
- Create: `plugins/cursor-relay/tests/hooks.test.mjs`
- Modify: `plugins/cursor-relay/CHANGELOG.md`
- Modify: `plugins/cursor-relay/NOTICE`
- Modify: `plugins/cursor-relay/PROVENANCE.md`

**Interfaces:**
- Produces: SessionStart/SessionEnd provider-local context and cleanup.
- No `Stop` hook entry.

- [ ] **Step 1: Write failing hook tests**

Test:

```js
test("Cursor hooks are provider-scoped and never block Stop", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  assert.equal(Object.hasOwn(hooks.hooks, "Stop"), false);
  assert.ok(hooks.hooks.SessionStart);
  assert.ok(hooks.hooks.SessionEnd);
});

test("session cleanup retains active and pinned jobs", () => {
  const result = pruneJobs(fixtureJobs, { now, maxAgeDays: 30, maxJobs: 200 });
  assert.ok(result.kept.some((job) => job.status === "running"));
  assert.ok(result.kept.some((job) => job.pinned));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test plugins/cursor-relay/tests/hooks.test.mjs
```

Expected: non-zero exit because hooks are absent.

- [ ] **Step 3: Implement non-blocking lifecycle hooks**

SessionStart records Claude session ID, transcript path, and plugin data directory for Cursor jobs. SessionEnd marks orphaned current-session jobs `interrupted` only after process verification, releases stale owned leases, and prunes within policy.

The hook always exits without blocking Claude Stop behavior.

- [ ] **Step 4: Finalize license, provenance, and changelog**

Document:

- Clean implementation.
- Inspected MIT reference commit.
- No Cursor SDK dependency.
- CLI baseline version.
- Composer 2.5 Standard default.
- Review safety gate.
- Windows launcher strategy.

Add the 1.0.0 changelog entry.

- [ ] **Step 5: Run the complete Cursor gate**

Run:

```powershell
node tooling/sync-contracts.mjs
npm --prefix plugins/cursor-relay test
node tooling/check-plugin-isolation.mjs
node tooling/check-forbidden-flags.mjs
```

Expected: every command exits 0; no isolation or unsafe-default violation is reported.

- [ ] **Step 6: Commit**

```powershell
git add plugins/cursor-relay
git commit -m "feat: release Cursor Relay 1.0.0"
```

## Cursor completion gate

Run:

```powershell
npm --prefix plugins/cursor-relay test
npm run check:isolation
npm run check:safety
git status --short
```

Expected: all commands exit 0 and the worktree is clean.
