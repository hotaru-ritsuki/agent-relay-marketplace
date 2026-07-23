# Codex Relay Import and Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Codex Relay with provenance intact, preserve every v1.1.6 command, and release an isolated v1.2.0 plugin implementing the approved common lifecycle.

**Architecture:** Import a non-squashed split of the existing `plugins/codex` history into `plugins/cdx-relay`. Preserve the app-server broker and compatibility commands, then add focused contract, atomic-state, lease, snapshot, migration, and controller modules around the existing runtime.

**Tech Stack:** Node.js ESM 20+, Codex CLI 0.145.0 compatibility baseline, Codex app-server, generated TypeScript protocol declarations, Node built-in tests, Apache-2.0.

## Global Constraints

- Depends on the completed foundation plan.
- Import source: `D:\PersonalProjects\codex-cc-relay-plugin`.
- Import commit: `9000f8fbfcf846531b2a8bce4756cfe2d2798b52`.
- Inspected OpenAI upstream base: `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Target plugin identity/version: `cdx-relay` 1.2.0.
- Preserve `rescue`, `transfer`, `review`, `adversarial-review`, `setup`, `status`, `result`, and `cancel`.
- Add `delegate`, `doctor`, and `resume`.
- Keep the app-server broker primary; `codex exec` is explicit-only.
- Keep the Stop review gate available and disabled by default.
- Runtime state lives only under this plugin’s `${CLAUDE_PLUGIN_DATA}`.
- Do not import runtime code from root contracts or Cursor Relay.
- Native Windows cancellation and file-write behavior are release-blocking.
- The standalone aggregate suite exceeded 120 seconds during planning; the imported suite must complete deterministically before this plan is complete.

---

## File map

| Path | Responsibility |
|---|---|
| `plugins/cdx-relay/.claude-plugin/plugin.json` | Plugin identity and version |
| `plugins/cdx-relay/commands/*.md` | Existing and common slash-command surface |
| `plugins/cdx-relay/scripts/codex-companion.mjs` | Compatibility CLI entrypoint |
| `plugins/cdx-relay/scripts/relay-controller.mjs` | Common delegate/status/result/cancel/resume orchestration |
| `plugins/cdx-relay/scripts/lib/codex-transport.mjs` | App-server transport facade |
| `plugins/cdx-relay/scripts/lib/contracts.mjs` | Runtime contract validation |
| `plugins/cdx-relay/scripts/lib/atomic-json.mjs` | Locked atomic JSON replacement and quarantine |
| `plugins/cdx-relay/scripts/lib/job-store.mjs` | Per-job state and event persistence |
| `plugins/cdx-relay/scripts/lib/relay-errors.mjs` | Stable error codes and redaction |
| `plugins/cdx-relay/scripts/lib/workspace-lease.mjs` | Neutral cross-provider mutation lease |
| `plugins/cdx-relay/scripts/lib/workspace-snapshot.mjs` | Baseline/final workspace delta |
| `plugins/cdx-relay/scripts/lib/legacy-migration.mjs` | Non-destructive legacy state import |
| `plugins/cdx-relay/tooling/generate-app-server-types.mjs` | Cross-platform protocol generation |
| `plugins/cdx-relay/tests/*.test.mjs` | Imported and new plugin-local tests |
| `plugins/cdx-relay/PROVENANCE.md` | Source repository, commits, import method |

### Task 1: Import the plugin subtree with history and provenance

**Files:**
- Create by history import: `plugins/cdx-relay/**`
- Create: `plugins/cdx-relay/package.json`
- Create: `plugins/cdx-relay/PROVENANCE.md`
- Create: `tests/codex/import.test.mjs`
- Copy: `D:\PersonalProjects\codex-cc-relay-plugin\tests\*.mjs` to `plugins/cdx-relay/tests/`
- Copy: `D:\PersonalProjects\codex-cc-relay-plugin\tsconfig.app-server.json` to `plugins/cdx-relay/tsconfig.app-server.json`

**Interfaces:**
- Consumes: source Git history and current plugin subtree.
- Produces: isolated plugin root with eight compatibility commands and source attribution.

- [ ] **Step 1: Write the failing import test**

Create `tests/codex/import.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const plugin = path.join(root, "plugins", "cdx-relay");

test("Codex Relay import preserves identity, commands, and provenance", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "cdx-relay");
  assert.equal(manifest.version, "1.1.6");
  for (const name of ["rescue", "transfer", "review", "adversarial-review", "setup", "status", "result", "cancel"]) {
    assert.ok(fs.existsSync(path.join(plugin, "commands", `${name}.md`)), name);
  }
  assert.match(fs.readFileSync(path.join(plugin, "LICENSE"), "utf8"), /Apache License/);
  assert.match(fs.readFileSync(path.join(plugin, "NOTICE"), "utf8"), /OpenAI/);
  const provenance = fs.readFileSync(path.join(plugin, "PROVENANCE.md"), "utf8");
  assert.match(provenance, /9000f8fbfcf846531b2a8bce4756cfe2d2798b52/);
  assert.match(provenance, /db52e28f4d9ded852ab3942cea316258ae4ef346/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test tests/codex/import.test.mjs
```

Expected: non-zero exit with `ENOENT` for `plugins/cdx-relay/.claude-plugin/plugin.json`.

- [ ] **Step 3: Create a temporary history split and import it**

Run from the monorepo root:

```powershell
$sourceRepo = "D:\PersonalProjects\codex-cc-relay-plugin"
$splitRepo = Join-Path $env:TEMP "cdx-relay-split-$PID"
git clone --no-local $sourceRepo $splitRepo
git -C $splitRepo checkout 9000f8fbfcf846531b2a8bce4756cfe2d2798b52
git -C $splitRepo subtree split --prefix=plugins/codex -b cdx-relay-plugin-history
git remote add cdx-relay-import $splitRepo
git fetch cdx-relay-import cdx-relay-plugin-history
git subtree add --prefix=plugins/cdx-relay cdx-relay-import cdx-relay-plugin-history
git remote remove cdx-relay-import
```

Expected: `plugins/cdx-relay/.claude-plugin/plugin.json` exists and `git log -- plugins/cdx-relay` contains imported source commits.

- [ ] **Step 4: Relocate the existing tests and build configuration**

Run:

```powershell
New-Item -ItemType Directory -Path "plugins\cdx-relay\tests" -Force
Copy-Item -LiteralPath "D:\PersonalProjects\codex-cc-relay-plugin\tests\helpers.mjs" -Destination "plugins\cdx-relay\tests\helpers.mjs"
Copy-Item -LiteralPath "D:\PersonalProjects\codex-cc-relay-plugin\tests\fake-codex-fixture.mjs" -Destination "plugins\cdx-relay\tests\fake-codex-fixture.mjs"
Get-ChildItem -LiteralPath "D:\PersonalProjects\codex-cc-relay-plugin\tests" -Filter "*.test.mjs" | Copy-Item -Destination "plugins\cdx-relay\tests"
Copy-Item -LiteralPath "D:\PersonalProjects\codex-cc-relay-plugin\tsconfig.app-server.json" -Destination "plugins\cdx-relay\tsconfig.app-server.json"
New-Item -ItemType Directory -Path "plugins\cdx-relay\tooling" -Force
Copy-Item -LiteralPath "D:\PersonalProjects\codex-cc-relay-plugin\scripts\bump-version.mjs" -Destination "plugins\cdx-relay\tooling\bump-version.mjs"
```

Mechanically replace imported test paths from `../plugins/codex/` to `../`, update any plugin-root calculation from the old repository layout to `plugins/cdx-relay`, and update the relocated bump-version test to import `../tooling/bump-version.mjs`.

- [ ] **Step 5: Add package metadata and provenance**

Create `plugins/cdx-relay/package.json`:

```json
{
  "name": "@hotaru-ritsuki/cdx-relay",
  "version": "1.1.6",
  "private": true,
  "type": "module",
  "license": "Apache-2.0",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "test": "node --test --test-timeout=30000 tests/*.test.mjs",
    "generate-types": "node tooling/generate-app-server-types.mjs",
    "build": "tsc -p tsconfig.app-server.json"
  }
}
```

Create `plugins/cdx-relay/PROVENANCE.md`:

```markdown
# Codex Relay provenance

- Imported from: https://github.com/hotaru-ritsuki/codex-relay-plugin
- Imported source commit: `9000f8fbfcf846531b2a8bce4756cfe2d2798b52`
- Inspected OpenAI upstream base: `db52e28f4d9ded852ab3942cea316258ae4ef346`
- Import method: non-squashed `git subtree split` of `plugins/codex`
- Import date: 2026-07-23

The GitHub fork-network relationship had been removed before this import. Commit ancestry, Apache-2.0, NOTICE, and modified-source attribution are retained.
```

- [ ] **Step 6: Run the import and focused compatibility tests**

Run:

```powershell
node --test tests/codex/import.test.mjs
node --test plugins/cdx-relay/tests/commands.test.mjs plugins/cdx-relay/tests/process.test.mjs
```

Expected: all selected tests pass with 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add plugins/cdx-relay tests/codex/import.test.mjs
git commit -m "feat: import Codex Relay with provenance"
```

### Task 2: Make app-server generation and the imported suite deterministic

**Files:**
- Create: `plugins/cdx-relay/tooling/generate-app-server-types.mjs`
- Create: `plugins/cdx-relay/tests/build-tooling.test.mjs`
- Modify: `plugins/cdx-relay/package.json`
- Modify: `plugins/cdx-relay/tsconfig.app-server.json`
- Modify: `plugins/cdx-relay/tests/helpers.mjs`

**Interfaces:**
- Consumes: `codex app-server generate-ts --out <dir>`.
- Produces: `generateAppServerTypes({ codexCommand, outputDir, spawnSyncImpl })`.

- [ ] **Step 1: Write the failing cross-platform generation test**

Create `plugins/cdx-relay/tests/build-tooling.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateAppServerTypes } from "../tooling/generate-app-server-types.mjs";

test("type generation creates its directory and uses argument-array spawning", () => {
  const outputDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdx-types-")), "types");
  let call;
  generateAppServerTypes({
    codexCommand: "codex",
    outputDir,
    spawnSyncImpl(command, args, options) {
      call = { command, args, options };
      return { status: 0 };
    }
  });
  assert.equal(fs.existsSync(outputDir), true);
  assert.deepEqual(call.args, ["app-server", "generate-ts", "--out", outputDir]);
  assert.equal(call.options.shell, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test plugins/cdx-relay/tests/build-tooling.test.mjs
```

Expected: non-zero exit because the tooling module is absent.

- [ ] **Step 3: Implement cross-platform generation**

Create `plugins/cdx-relay/tooling/generate-app-server-types.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function generateAppServerTypes({
  codexCommand = "codex",
  outputDir,
  spawnSyncImpl = spawnSync
}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const result = spawnSyncImpl(
    codexCommand,
    ["app-server", "generate-ts", "--out", outputDir],
    { encoding: "utf8", shell: false, stdio: "inherit" }
  );
  if (result.status !== 0) throw new Error(`Codex type generation failed with ${result.status}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  generateAppServerTypes({
    outputDir: path.join(pluginRoot, ".generated", "app-server-types")
  });
}
```

Update `plugins/cdx-relay/package.json` so `build` runs `generate-types` before `tsc` without POSIX `mkdir`.

Replace `plugins/cdx-relay/tsconfig.app-server.json` with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": false,
    "noImplicitAny": false,
    "useUnknownInCatchVariables": false,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": [
    "scripts/lib/app-server.mjs",
    "scripts/lib/codex.mjs",
    "scripts/lib/fs.mjs",
    "scripts/lib/process.mjs",
    "scripts/lib/app-server-protocol.d.ts",
    ".generated/app-server-types/**/*.ts"
  ]
}
```

- [ ] **Step 4: Bound and clean imported tests**

Update `plugins/cdx-relay/tests/helpers.mjs` so every fake broker and child process is registered in a `Set`, removed on normal completion, and terminated from `afterEach`. Export:

```js
export function trackChild(child) {
  trackedChildren.add(child);
  child.once("exit", () => trackedChildren.delete(child));
  return child;
}

export async function cleanupTrackedChildren() {
  for (const child of trackedChildren) {
    if (child.exitCode === null) child.kill();
  }
  trackedChildren.clear();
}
```

Register `afterEach(cleanupTrackedChildren)` in test files that launch brokers or workers.

- [ ] **Step 5: Run focused and aggregate tests**

Run:

```powershell
node --test plugins/cdx-relay/tests/build-tooling.test.mjs
npm --prefix plugins/cdx-relay test
```

Expected: the generation test passes; the aggregate imported suite exits within 120 seconds with 0 failures and no surviving plugin-owned child process.

- [ ] **Step 6: Commit**

```powershell
git add plugins/cdx-relay
git commit -m "build: make Codex tests and type generation deterministic"
```

### Task 3: Replace whole-file state with atomic per-job persistence

**Files:**
- Create: `plugins/cdx-relay/scripts/lib/atomic-json.mjs`
- Create: `plugins/cdx-relay/scripts/lib/contracts.mjs`
- Create: `plugins/cdx-relay/scripts/lib/job-store.mjs`
- Create: `plugins/cdx-relay/tests/job-store.test.mjs`
- Modify: `plugins/cdx-relay/scripts/lib/state.mjs`

**Interfaces:**
- Produces: `writeAtomicJson(file, value)`, `readValidatedJson(file, validate)`, `createJobStore({ pluginDataDir, workspaceRoot, clock })`.
- `createJobStore` returns `create`, `transition`, `appendEvent`, `complete`, `read`, `list`, and `prune`.

- [ ] **Step 1: Write failing atomic-state tests**

Create `plugins/cdx-relay/tests/job-store.test.mjs` with tests that:

```js
test("job store creates one directory per job and terminalizes once", () => {
  const store = createFixtureStore();
  const job = store.create(validQueuedJob);
  store.transition(job.jobId, { status: "running" });
  store.complete(job.jobId, validCompletedResult);
  assert.throws(() => store.complete(job.jobId, validCompletedResult), /already terminal/);
  assert.equal(store.read(job.jobId).metadata.status, "completed");
});

test("invalid JSON is quarantined instead of overwritten", () => {
  const store = createFixtureStore();
  const job = store.create(validQueuedJob);
  fs.writeFileSync(store.paths(job.jobId).metadata, "{broken");
  assert.throws(() => store.read(job.jobId), /STATE_CORRUPTION/);
  assert.equal(fs.readdirSync(store.paths(job.jobId).directory).some((name) => name.includes(".corrupt-")), true);
});
```

The fixture supplies schema-valid records from the synchronized contract fixtures.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
node --test plugins/cdx-relay/tests/job-store.test.mjs
```

Expected: non-zero exit because `job-store.mjs` is absent.

- [ ] **Step 3: Implement atomic JSON and contract validation**

`writeAtomicJson` must:

1. Create the parent directory.
2. Write UTF-8 JSON to `<file>.<pid>.<nonce>.tmp`.
3. Flush and close the file.
4. Rename with bounded Windows retry for `EPERM`, `EACCES`, and `EBUSY`.
5. Remove only its own temporary file on failure.

`readValidatedJson` must rename invalid input to `<file>.corrupt-<timestamp>` and throw an error with code `STATE_CORRUPTION`.

`contracts.mjs` must validate the required v1 fields and reject the obsolete status `done`.

- [ ] **Step 4: Implement the per-job store and compatibility adapter**

`job-store.mjs` stores:

```text
<pluginDataDir>/workspaces/<hash>/jobs/<job-id>/metadata.json
<pluginDataDir>/workspaces/<hash>/jobs/<job-id>/events.jsonl
<pluginDataDir>/workspaces/<hash>/jobs/<job-id>/result.json
<pluginDataDir>/workspaces/<hash>/jobs/<job-id>/process.json
```

Adapt `state.mjs` exports so existing callers continue to work while reading/writing through `job-store.mjs`. Preserve legacy resolution behavior for status, result, and cancellation.

- [ ] **Step 5: Run state and imported runtime tests**

Run:

```powershell
node --test plugins/cdx-relay/tests/job-store.test.mjs plugins/cdx-relay/tests/state.test.mjs plugins/cdx-relay/tests/runtime.test.mjs
```

Expected: all selected tests pass with 0 failures.

- [ ] **Step 6: Commit**

```powershell
git add plugins/cdx-relay/scripts/lib plugins/cdx-relay/tests
git commit -m "refactor: persist Codex jobs atomically"
```

### Task 4: Add leases, snapshots, structured errors, and result envelopes

**Files:**
- Create: `plugins/cdx-relay/scripts/lib/relay-errors.mjs`
- Create: `plugins/cdx-relay/scripts/lib/workspace-lease.mjs`
- Create: `plugins/cdx-relay/scripts/lib/workspace-snapshot.mjs`
- Create: `plugins/cdx-relay/tests/relay-safety.test.mjs`
- Modify: `plugins/cdx-relay/scripts/lib/process.mjs`
- Modify: `plugins/cdx-relay/scripts/lib/render.mjs`

**Interfaces:**
- Produces: `RelayError`, `acquireWorkspaceLease`, `releaseWorkspaceLease`, `captureWorkspaceSnapshot`, `diffWorkspaceSnapshots`, `toResultEnvelope`.

- [ ] **Step 1: Write failing safety tests**

Cover:

```js
test("active Cursor lease blocks a Codex mutation", () => {
  const lease = writeLease({ provider: "cursor", pid: process.pid, nonce: "1234567890abcdef" });
  assert.throws(
    () => acquireWorkspaceLease({ provider: "codex", workspaceRoot, jobId: "job-00000003" }),
    (error) => error.code === "CONCURRENT_MUTATION"
  );
  assert.equal(fs.existsSync(lease), true);
});

test("stale verified lease is replaced", () => {
  writeLease({ provider: "cursor", pid: 999999, expiresAt: "2020-01-01T00:00:00.000Z" });
  const lease = acquireWorkspaceLease({ provider: "codex", workspaceRoot, jobId: "job-00000003" });
  assert.equal(lease.provider, "codex");
});

test("result envelope distinguishes partial output from completion", () => {
  const result = toResultEnvelope({ job: runningJob, output: "useful", terminalReason: "provider-crash" });
  assert.equal(result.status, "partial");
  assert.equal(result.retrySafety, "unknown");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test plugins/cdx-relay/tests/relay-safety.test.mjs
```

Expected: non-zero exit because the new modules are absent.

- [ ] **Step 3: Implement the stable error and lease contracts**

`RelayError` constructor signature:

```js
new RelayError(code, message, {
  providerDetail = null,
  suggestedAction = null,
  retrySafety = "unknown",
  cause = null
} = {})
```

Lease resolution uses the Git common directory when `git rev-parse --git-common-dir` succeeds; otherwise it uses `path.join(os.tmpdir(), "agent-relay-leases", workspaceHash)`. Validate provider, job ID, PID, process creation time, nonce, and expiry before replacing a lease.

- [ ] **Step 4: Implement workspace snapshots and result mapping**

Git snapshots record `HEAD`, porcelain-v2 status, and a stable hash of the working-tree diff. Non-Git snapshots record relative path, size, modified time, and a content hash for changed candidates. Exclude `.git`, plugin data, dependency caches, and generated diagnostic logs.

`toResultEnvelope` maps existing Codex job output into the v1 result schema while retaining Codex-native details under `extensions.codex`.

- [ ] **Step 5: Harden Windows process identity**

Extend `process.mjs` so stored process identity contains:

```js
{
  pid,
  processStartedAt,
  nonce
}
```

Provider-native `turn/interrupt` remains first. `taskkill /PID <pid> /T /F` runs only after stored identity validation and graceful timeout.

- [ ] **Step 6: Run the safety, process, state, and render tests**

Run:

```powershell
node --test plugins/cdx-relay/tests/relay-safety.test.mjs plugins/cdx-relay/tests/process.test.mjs plugins/cdx-relay/tests/state.test.mjs plugins/cdx-relay/tests/render.test.mjs
```

Expected: all selected tests pass with 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add plugins/cdx-relay/scripts/lib plugins/cdx-relay/tests
git commit -m "feat: add Codex relay safety contracts"
```

### Task 5: Add the common commands without breaking Codex compatibility

**Files:**
- Create: `plugins/cdx-relay/commands/delegate.md`
- Create: `plugins/cdx-relay/commands/doctor.md`
- Create: `plugins/cdx-relay/commands/resume.md`
- Create: `plugins/cdx-relay/scripts/relay-controller.mjs`
- Create: `plugins/cdx-relay/scripts/lib/codex-transport.mjs`
- Create: `plugins/cdx-relay/tests/common-commands.test.mjs`
- Modify: `plugins/cdx-relay/scripts/codex-companion.mjs`
- Modify: `plugins/cdx-relay/commands/status.md`
- Modify: `plugins/cdx-relay/commands/result.md`
- Modify: `plugins/cdx-relay/commands/cancel.md`

**Interfaces:**
- Produces: `runDelegate`, `runDoctor`, `runResume`, `runStatus`, `runResult`, `runCancel`.
- Transport interface: `detect`, `start`, `stream`, `resume`, `interrupt`, `dispose`.

- [ ] **Step 1: Write failing common-command tests**

Tests must assert:

```js
test("common Codex commands are exposed", () => {
  for (const name of ["delegate", "doctor", "resume"]) {
    assert.ok(fs.existsSync(path.join(pluginRoot, "commands", `${name}.md`)));
  }
});

test("receipts always print explicit status, result, and cancel commands", async () => {
  const receipt = await runDelegate(fixtureRequest);
  assert.match(receipt.text, new RegExp(`/cdx-relay:status ${receipt.jobId}`));
  assert.match(receipt.text, new RegExp(`/cdx-relay:result ${receipt.jobId}`));
  assert.match(receipt.text, new RegExp(`/cdx-relay:cancel ${receipt.jobId}`));
});

test("legacy result and cancel omission remain unambiguous only", () => {
  assert.equal(resolveResultReference([], currentSessionJobs), latestCompleted.jobId);
  assert.throws(() => resolveCancelReference([], twoActiveJobs), /Multiple Codex jobs/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test plugins/cdx-relay/tests/common-commands.test.mjs
```

Expected: non-zero exit because common commands/controller are absent.

- [ ] **Step 3: Add command documents**

`delegate.md` invokes:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" delegate --json $ARGUMENTS
```

`doctor.md` invokes:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" doctor --json
```

`resume.md` requires a job ID and invokes:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" resume --json $ARGUMENTS
```

Each document restricts its allowed tools to the minimum existing Node/Git/AskUserQuestion surface.

- [ ] **Step 4: Implement the controller and app-server transport facade**

`runDelegate` performs preflight, lease acquisition, durable job creation, transport start, stream handling, snapshot diff, terminalization, and receipt rendering.

`runDoctor` is read-only and reports binary, CLI version, app-server capability, authentication readiness, schema compatibility, state health, and Windows process support.

`runResume` reads the exact stored Codex thread ID, starts a linked child job, and never guesses from another Claude session.

`codex-transport.mjs` adapts the existing broker/client to the approved transport interface; it does not replace the broker.

- [ ] **Step 5: Wire the compatibility entrypoint**

Add `delegate`, `doctor`, and `resume` cases to `codex-companion.mjs`. Existing cases remain. Preserve:

- `result` without ID resolves the latest eligible finished job in the current Claude session.
- `cancel` without ID works only with one unambiguous active job.
- `rescue`, `review`, and `adversarial-review` foreground/background selection.
- `transfer` native import behavior.
- Stop review gate default `false`.

- [ ] **Step 6: Run command and runtime tests**

Run:

```powershell
node --test plugins/cdx-relay/tests/common-commands.test.mjs plugins/cdx-relay/tests/commands.test.mjs plugins/cdx-relay/tests/runtime.test.mjs
```

Expected: all selected tests pass with 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add plugins/cdx-relay
git commit -m "feat: add common Codex relay commands"
```

### Task 6: Add legacy migration and release Codex Relay 1.2.0

**Files:**
- Create: `plugins/cdx-relay/scripts/lib/legacy-migration.mjs`
- Create: `plugins/cdx-relay/tests/legacy-migration.test.mjs`
- Modify: `plugins/cdx-relay/scripts/codex-companion.mjs`
- Modify: `plugins/cdx-relay/commands/setup.md`
- Modify: `plugins/cdx-relay/.claude-plugin/plugin.json`
- Modify: `plugins/cdx-relay/package.json`
- Modify: `plugins/cdx-relay/CHANGELOG.md`
- Modify: `plugins/cdx-relay/PROVENANCE.md`

**Interfaces:**
- Produces: `detectLegacyState`, `planLegacyImport`, `importLegacyState`.
- Legacy identity: `cdx-relay@codex-cc-relay`.
- New identity: `cdx-relay@agent-relay-marketplace`.

- [ ] **Step 1: Write failing migration tests**

Test that:

```js
test("legacy import copies compatible state without modifying source", () => {
  const before = hashTree(legacyRoot);
  const first = importLegacyState({ legacyRoot, targetRoot });
  const second = importLegacyState({ legacyRoot, targetRoot });
  assert.equal(first.importedJobs, 2);
  assert.equal(second.importedJobs, 0);
  assert.equal(hashTree(legacyRoot), before);
  assert.ok(fs.existsSync(path.join(targetRoot, "migrations", "legacy-import.json")));
});

test("legacy import rejects invalid source state", () => {
  fs.writeFileSync(path.join(legacyRoot, "state.json"), "{broken");
  assert.throws(() => importLegacyState({ legacyRoot, targetRoot }), /STATE_CORRUPTION/);
  assert.equal(fs.readdirSync(targetRoot).length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test plugins/cdx-relay/tests/legacy-migration.test.mjs
```

Expected: non-zero exit because `legacy-migration.mjs` is absent.

- [ ] **Step 3: Implement detection, dry-run planning, and idempotent copy**

`doctor` reports legacy presence without writing. `setup --import-legacy-state` prints a dry-run plan, requires explicit confirmation through the command workflow, copies only validated configuration and jobs, skips credentials, writes a migration journal, and never deletes or edits the legacy directory.

- [ ] **Step 4: Bump only Codex Relay to 1.2.0**

Set `1.2.0` in:

- `plugins/cdx-relay/.claude-plugin/plugin.json`
- `plugins/cdx-relay/package.json`

Add a `1.2.0` changelog entry covering common commands, atomic job storage, leases, normalized results, Windows hardening, and legacy import. Update provenance with the monorepo import commit after Task 1’s commit exists.

- [ ] **Step 5: Run the complete Codex gate**

Run:

```powershell
node tooling/sync-contracts.mjs
npm --prefix plugins/cdx-relay test
npm --prefix plugins/cdx-relay run build
node tooling/check-plugin-isolation.mjs
node tooling/check-forbidden-flags.mjs
```

Expected: every command exits 0; the complete Codex suite finishes within 120 seconds; no isolation or unsafe-default violation is reported.

- [ ] **Step 6: Commit**

```powershell
git add plugins/cdx-relay
git commit -m "feat: release Codex Relay 1.2.0"
```

## Codex completion gate

Run:

```powershell
npm --prefix plugins/cdx-relay test
npm --prefix plugins/cdx-relay run build
npm run check:isolation
npm run check:safety
git status --short
```

Expected: all commands exit 0 and the worktree is clean.
