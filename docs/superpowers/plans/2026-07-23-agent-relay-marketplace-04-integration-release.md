# Agent Relay Marketplace Integration and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a validated catalog over the two isolated plugins, prove cross-provider safety and independent releases, and establish Windows-first CI and release evidence.

**Architecture:** The root marketplace references local strict plugin sources and contains no runtime. Integration tooling packages each plugin independently, validates schemas and manifests, tests the neutral lease protocol, hashes source artifacts, and emits compatibility/release evidence without storing credentials.

**Tech Stack:** Claude Code 2.1.215 compatibility baseline, Node.js 20/22, GitHub Actions on Windows/Linux/macOS, Codex CLI 0.145.0, Cursor Agent CLI 2026.07.20-8cc9c0b, PowerShell-compatible Node tooling.

## Global Constraints

- Depends on completed Foundation, Codex Relay, and Cursor Relay plans.
- Marketplace name: `agent-relay-marketplace`.
- Marketplace is catalog-only and exposes no command, hook, runtime, auth, or state.
- Marketplace entries use `strict: true` and relative sources.
- Plugin versions exist only in plugin manifests.
- Expected versions: `cdx-relay` 1.2.0 and `cursor-relay` 1.0.0.
- Windows is release-blocking.
- Ordinary CI uses fakes and contains no provider credentials.
- Paid/authenticated live smoke runs require explicit user approval at execution time.
- Do not globally install, tag, push, or publish without separate user authorization.

---

## File map

| Path | Responsibility |
|---|---|
| `.claude-plugin/marketplace.json` | Catalog identity and two strict local plugin sources |
| `README.md` | Installation, independence, commands, safety defaults |
| `CHANGELOG.md` | Marketplace-only changes |
| `tooling/package-plugin.mjs` | Build an isolated plugin directory |
| `tooling/check-versions.mjs` | Enforce independent manifest/catalog versions |
| `tooling/hash-artifact.mjs` | Deterministic source artifact hash |
| `tooling/smoke-local.mjs` | Safe local doctor and explicitly authorized live smoke |
| `tests/marketplace/*.test.mjs` | Catalog/manifest behavior |
| `tests/packaging/*.test.mjs` | Artifact contents and isolation |
| `tests/integration/*.test.mjs` | Cross-provider leases, lifecycle schemas, migration |
| `.github/workflows/pull-request-ci.yml` | Secretless multi-platform gates |
| `.github/workflows/release-check.yml` | Manual release evidence |
| `docs/compatibility.md` | Tested provider/OS/Node matrix |
| `docs/migrating-cdx-relay.md` | Legacy install/data migration |
| `docs/release-checklist.md` | Approval-sensitive release procedure |

### Task 1: Create the catalog-only marketplace and user documentation

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `tests/marketplace/catalog.test.mjs`

**Interfaces:**
- Consumes: `plugins/cdx-relay` 1.2.0 and `plugins/cursor-relay` 1.0.0.
- Produces: installable `agent-relay-marketplace` catalog with no duplicated plugin versions.

- [ ] **Step 1: Write the failing catalog test**

Create `tests/marketplace/catalog.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("marketplace is catalog-only and lists exactly two strict plugins", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(catalog.name, "agent-relay-marketplace");
  assert.deepEqual(catalog.plugins.map((plugin) => plugin.name), ["cdx-relay", "cursor-relay"]);
  assert.deepEqual(catalog.plugins.map((plugin) => plugin.source), [
    "./plugins/cdx-relay",
    "./plugins/cursor-relay"
  ]);
  for (const plugin of catalog.plugins) {
    assert.equal(plugin.strict, true);
    assert.equal(Object.hasOwn(plugin, "version"), false);
  }
  assert.equal(Object.hasOwn(catalog, "commands"), false);
  assert.equal(Object.hasOwn(catalog, "hooks"), false);
  assert.equal(Object.hasOwn(catalog, "mcpServers"), false);
});

test("plugin manifest versions are independently authoritative", () => {
  const cdx = JSON.parse(fs.readFileSync(path.join(root, "plugins/cdx-relay/.claude-plugin/plugin.json"), "utf8"));
  const cursor = JSON.parse(fs.readFileSync(path.join(root, "plugins/cursor-relay/.claude-plugin/plugin.json"), "utf8"));
  assert.equal(cdx.version, "1.2.0");
  assert.equal(cursor.version, "1.0.0");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test tests/marketplace/catalog.test.mjs
```

Expected: non-zero exit with `ENOENT` for `.claude-plugin/marketplace.json`.

- [ ] **Step 3: Add the marketplace catalog**

Create `.claude-plugin/marketplace.json`:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-marketplace.json",
  "name": "agent-relay-marketplace",
  "owner": {
    "name": "hotaru-ritsuki"
  },
  "metadata": {
    "description": "Independent Codex Relay and Cursor Relay plugins for Claude Code."
  },
  "plugins": [
    {
      "name": "cdx-relay",
      "source": "./plugins/cdx-relay",
      "description": "Delegate tasks and reviews to Codex.",
      "category": "development",
      "tags": ["codex", "delegation", "review"],
      "strict": true
    },
    {
      "name": "cursor-relay",
      "source": "./plugins/cursor-relay",
      "description": "Delegate tasks and enforced read-only reviews to the local Cursor Agent CLI.",
      "category": "development",
      "tags": ["cursor", "delegation", "review"],
      "strict": true
    }
  ]
}
```

- [ ] **Step 4: Add README and marketplace changelog**

README must include:

```text
/plugin marketplace add <repository-url>
/plugin install cdx-relay@agent-relay-marketplace
/plugin install cursor-relay@agent-relay-marketplace
```

Document independent installation/auth/state/release/uninstall, both command namespaces, CLI-only Cursor billing, safety defaults, Windows support, and the absence of `/agent-relay:*`.

`CHANGELOG.md` begins with marketplace 1.0.0 and links each plugin changelog.

- [ ] **Step 5: Run the catalog and Claude validation gates**

Run:

```powershell
node --test tests/marketplace/catalog.test.mjs
claude plugin validate .
claude plugin validate plugins/cdx-relay
claude plugin validate plugins/cursor-relay
```

Expected: catalog tests pass and all three Claude validation commands exit 0.

- [ ] **Step 6: Commit**

```powershell
git add .claude-plugin README.md CHANGELOG.md tests/marketplace
git commit -m "feat: add agent relay marketplace catalog"
```

### Task 2: Prove isolated packaging and cross-provider lease interoperability

**Files:**
- Create: `tooling/package-plugin.mjs`
- Create: `tests/packaging/plugin-artifacts.test.mjs`
- Create: `tests/integration/cross-provider-lease.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `packagePlugin({ pluginDir, outputDir })`.
- Packaged allowlist: manifest, commands, skills, agents, hooks, prompts, schemas, types, scripts, LICENSE, NOTICE, PROVENANCE, CHANGELOG, package metadata required at runtime.

- [ ] **Step 1: Write failing package-isolation tests**

Create `tests/packaging/plugin-artifacts.test.mjs` with this setup and test:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packagePlugin } from "../../tooling/package-plugin.mjs";
import { checkPluginIsolation } from "../../tooling/check-plugin-isolation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-artifacts-"));
const entrypoints = {
  "cdx-relay": "codex-companion.mjs",
  "cursor-relay": "cursor-relay.mjs"
};

function fixtureEnvironment(name) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: path.join(tempRoot, "data", name),
    CLAUDE_SESSION_ID: "artifact-test"
  };
}

test("each packaged plugin runs with the monorepo hidden", async () => {
  for (const name of ["cdx-relay", "cursor-relay"]) {
    const outputDir = path.join(tempRoot, name);
    packagePlugin({ pluginDir: path.join(root, "plugins", name), outputDir });
    assert.ok(fs.existsSync(path.join(outputDir, ".claude-plugin", "plugin.json")));
    assert.equal(checkPluginIsolation(outputDir).length, 0);
    const result = spawnSync(process.execPath, [path.join(outputDir, "scripts", entrypoints[name]), "doctor", "--json"], {
      cwd: tempRoot,
      env: fixtureEnvironment(name),
      encoding: "utf8",
      shell: false
    });
    assert.notEqual(result.error?.code, "MODULE_NOT_FOUND");
  }
});
```

Add a cross-provider test that imports each plugin’s independent lease implementation, acquires a Cursor lease, verifies Codex receives `CONCURRENT_MUTATION`, expires the Cursor lease, and verifies Codex can acquire.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test tests/packaging/plugin-artifacts.test.mjs tests/integration/cross-provider-lease.test.mjs
```

Expected: non-zero exit because `package-plugin.mjs` is absent.

- [ ] **Step 3: Implement deterministic isolated packaging**

`packagePlugin`:

1. Resolves and validates the plugin root.
2. Refuses an output directory inside the source plugin.
3. Copies only the approved top-level entries.
4. Excludes tests, temporary files, raw diagnostics, and generated caches.
5. Preserves executable mode where supported.
6. Runs contract synchronization before copying.
7. Runs isolation and forbidden-default checks against the copied artifact.

It never reads the sibling plugin while packaging.

- [ ] **Step 4: Make both lease implementations pass the neutral fixture**

Align only schema field names, workspace hash calculation, Git common-directory location, non-Git temporary location, and stale-lease validation. Keep implementations separate.

- [ ] **Step 5: Add root scripts**

Add:

```json
{
  "package:cdx": "node tooling/package-plugin.mjs cdx-relay",
  "package:cursor": "node tooling/package-plugin.mjs cursor-relay",
  "package": "npm run package:cdx && npm run package:cursor"
}
```

- [ ] **Step 6: Run packaging and integration tests**

Run:

```powershell
node --test tests/packaging/plugin-artifacts.test.mjs tests/integration/cross-provider-lease.test.mjs
npm run package
```

Expected: tests pass; `dist/cdx-relay` and `dist/cursor-relay` contain independent validated artifacts.

- [ ] **Step 7: Commit**

```powershell
git add tooling/package-plugin.mjs tests package.json
git commit -m "test: prove isolated relay artifacts"
```

### Task 3: Implement independent version and artifact provenance checks

**Files:**
- Create: `tooling/check-versions.mjs`
- Create: `tooling/hash-artifact.mjs`
- Create: `tests/tooling/release-metadata.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `checkVersions(rootDir)`, `hashArtifact(directory)`.
- Hash algorithm: SHA-256 over sorted relative path, mode, byte length, and content.

- [ ] **Step 1: Write failing release metadata tests**

Create `tests/tooling/release-metadata.test.mjs` with imports for `checkVersions` and `hashArtifact`, then define:

```js
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cdxArtifact = path.join(root, "dist", "cdx-relay");
const cursorArtifact = path.join(root, "dist", "cursor-relay");
const hashesForBoth = () => ({
  cdx: hashArtifact(cdxArtifact),
  cursor: hashArtifact(cursorArtifact)
});

test("catalog does not duplicate plugin versions", () => {
  assert.deepEqual(checkVersions(root).violations, []);
});

test("changing Cursor content changes only the Cursor artifact hash", () => {
  const before = hashesForBoth();
  fs.appendFileSync(path.join(cursorArtifact, "CHANGELOG.md"), "\nchange\n");
  const after = hashesForBoth();
  assert.equal(before.cdx, after.cdx);
  assert.notEqual(before.cursor, after.cursor);
});

test("artifact hash is independent of file enumeration order", () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hash-a-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hash-b-"));
  fs.writeFileSync(path.join(first, "a.txt"), "a");
  fs.writeFileSync(path.join(first, "b.txt"), "b");
  fs.writeFileSync(path.join(second, "b.txt"), "b");
  fs.writeFileSync(path.join(second, "a.txt"), "a");
  assert.equal(hashArtifact(first), hashArtifact(second));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test tests/tooling/release-metadata.test.mjs
```

Expected: non-zero exit because release tooling is absent.

- [ ] **Step 3: Implement version checks**

Reject:

- A plugin `version` field in a marketplace entry.
- Manifest/package version mismatch inside a plugin.
- Root version changes presented as a plugin version.
- Missing plugin changelog heading for its manifest version.
- Missing LICENSE, NOTICE, or PROVENANCE.

- [ ] **Step 4: Implement canonical artifact hashing**

Hash each included file in sorted forward-slash path order. Include path, normalized mode, byte length, and raw bytes. Exclude filesystem timestamps. Print:

```json
{
  "plugin": "cdx-relay",
  "version": "1.2.0",
  "algorithm": "sha256",
  "digest": "<64 lowercase hex characters>"
}
```

- [ ] **Step 5: Add root release-check script and run tests**

Add:

```json
{
  "check:versions": "node tooling/check-versions.mjs",
  "check:release": "npm run check && npm run package && npm run check:versions"
}
```

Run:

```powershell
node --test tests/tooling/release-metadata.test.mjs
npm run check:release
```

Expected: tests and release check pass with 0 violations.

- [ ] **Step 6: Commit**

```powershell
git add tooling tests/tooling package.json
git commit -m "build: add independent release provenance"
```

### Task 4: Add Windows-first, secretless CI

**Files:**
- Create: `.github/workflows/pull-request-ci.yml`
- Create: `.github/workflows/release-check.yml`
- Create: `tests/windows/platform-contracts.test.mjs`

**Interfaces:**
- Produces: required Windows Node 20/22 gates and compatibility Linux/macOS jobs.
- CI installs exact baseline Codex and Claude Code versions only for protocol/manifest checks.

- [ ] **Step 1: Write the platform contract test**

Create `tests/windows/platform-contracts.test.mjs` that verifies:

- Cursor Windows bundle discovery selects `node.exe` and `index.js`.
- Both process adapters treat missing `taskkill` targets as stopped and access-denied targets as failure.
- Atomic JSON retries `EPERM`, `EACCES`, and `EBUSY`, then stops at the configured bound.
- Workspace hashes are case-normalized on Windows.
- Paths with spaces and Unicode survive receipt/state round trips.
- Junction escape attempts fail containment.

- [ ] **Step 2: Run the platform test locally**

Run:

```powershell
node --test tests/windows/platform-contracts.test.mjs
```

Expected: all platform-contract tests pass on Windows.

- [ ] **Step 3: Add pull-request CI**

Create a workflow with:

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [windows-latest, ubuntu-latest, macos-latest]
    node: [20, 22]
```

Every job:

1. Checks out the repository.
2. Sets up the matrix Node version with npm cache.
3. Runs `npm ci`.
4. Runs `npm test`.
5. Runs `npm run check:isolation`.
6. Runs `npm run check:safety`.
7. Runs `npm run check:versions`.
8. Runs `npm run package`.

The Windows Node 22 job additionally installs:

```text
@anthropic-ai/claude-code@2.1.215
@openai/codex@0.145.0
```

It then runs all three `claude plugin validate` commands and the Codex app-server type build. No Cursor login or provider credentials are used.

- [ ] **Step 4: Add manual release-check workflow**

`workflow_dispatch` inputs select `cdx-relay`, `cursor-relay`, or `both`. The workflow runs the full secretless matrix, packages selected plugins, generates hashes, and uploads artifacts. It does not create tags or releases.

- [ ] **Step 5: Validate workflow syntax and run the local equivalent**

Run:

```powershell
npm run check:release
node --test tests/windows/platform-contracts.test.mjs
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```powershell
git add .github tests/windows
git commit -m "ci: add Windows-first relay verification"
```

### Task 5: Add compatibility, migration, and approval-sensitive release evidence

**Files:**
- Create: `tooling/smoke-local.mjs`
- Create: `tests/integration/smoke-policy.test.mjs`
- Create: `docs/compatibility.md`
- Create: `docs/migrating-cdx-relay.md`
- Create: `docs/release-checklist.md`
- Modify: `README.md`

**Interfaces:**
- Produces: safe default doctor smoke; paid provider execution requires both a CLI flag and environment authorization.

- [ ] **Step 1: Write the failing smoke-policy test**

Create `tests/integration/smoke-policy.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runSmoke } from "../../tooling/smoke-local.mjs";

const failIfCalled = () => {
  assert.fail("provider execution must not be called");
};

test("smoke runner cannot spend provider usage by default", async () => {
  const result = await runSmoke({ argv: [], env: {}, runProvider: failIfCalled });
  assert.equal(result.mode, "doctor-only");
  assert.equal(result.providerRuns, 0);
});

test("paid smoke requires flag and explicit environment authorization", async () => {
  await assert.rejects(
    runSmoke({ argv: ["--paid-provider-run"], env: {}, runProvider: failIfCalled }),
    /AGENT_RELAY_ALLOW_PAID_SMOKE=1/
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test tests/integration/smoke-policy.test.mjs
```

Expected: non-zero exit because `smoke-local.mjs` is absent.

- [ ] **Step 3: Implement safe local smoke**

Default behavior:

1. Package both plugins into a temporary directory.
2. Run each `doctor` against fixture provider executables.
3. Validate manifests.
4. Verify no global plugin installation or state path was modified.

Authenticated live provider work runs only when both are present:

```text
--paid-provider-run
AGENT_RELAY_ALLOW_PAID_SMOKE=1
```

The execution agent must still request user approval immediately before a paid smoke command.

- [ ] **Step 4: Write compatibility and migration documentation**

`docs/compatibility.md` records:

| Surface | Baseline |
|---|---|
| Claude Code | 2.1.215 |
| Codex CLI | 0.145.0 |
| Cursor Agent CLI | 2026.07.20-8cc9c0b |
| Node.js | 20 and 22 |
| Required OS | Windows |
| Compatibility OS | Linux and macOS |

`docs/migrating-cdx-relay.md` documents disabling the legacy `cdx-relay@codex-cc-relay`, installing the new plugin, running doctor, explicitly importing state, verifying commands, and rollback without deleting legacy data.

`docs/release-checklist.md` requires:

- Clean worktree.
- Full secretless matrix.
- Explicitly approved live smoke.
- Manifest/NOTICE/provenance review.
- Independent version/changelog review.
- Artifact hashes.
- User authorization before tag, push, GitHub release, or marketplace publication.

- [ ] **Step 5: Run the complete local verification**

Run:

```powershell
npm run check:release
node tooling/smoke-local.mjs
git diff --check
git status --short
```

Expected: release checks and doctor-only smoke exit 0; `git diff --check` has no output; `git status --short` lists only the documentation/smoke changes for this task before commit.

- [ ] **Step 6: Commit**

```powershell
git add tooling/smoke-local.mjs tests/integration/smoke-policy.test.mjs docs README.md
git commit -m "docs: add relay compatibility and release gates"
```

## Program completion gate

Run:

```powershell
npm ci
npm test
npm run check:isolation
npm run check:safety
npm run check:versions
npm run package
claude plugin validate .
claude plugin validate plugins/cdx-relay
claude plugin validate plugins/cursor-relay
npm --prefix plugins/cdx-relay run build
node tooling/smoke-local.mjs
git diff --check
git status --short
```

Expected:

- Every command exits 0.
- All tests pass with 0 failures.
- Both artifacts package independently.
- Marketplace and plugin validation pass.
- Doctor-only smoke performs no paid provider work.
- `git diff --check` produces no output.
- `git status --short` is empty.

Do not create tags, push branches, open pull requests, publish releases, globally install plugins, or run paid provider smoke until the user explicitly authorizes the corresponding action.
