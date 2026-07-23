# Agent Relay Marketplace Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize the monorepo and implement the versioned relay contracts plus artifact-safety tooling used by both plugins.

**Architecture:** Root tooling owns schemas, fixtures, test helpers, contract synchronization, and packaging checks. It does not ship as plugin runtime. Plugin directories receive copied contract artifacts and implement their own runtime validation.

**Tech Stack:** Git, Node.js ESM 20+, Node built-in test runner, Ajv 8, TypeScript declaration files, Apache-2.0.

## Global Constraints

- Marketplace identity: `agent-relay-marketplace`.
- Plugin identities: `cdx-relay` and `cursor-relay`; no `/agent-relay:*` command.
- Runtime floor: Node.js 20; Node.js 22 is required in the release matrix.
- Root license: Apache-2.0.
- Root contracts and tooling are build/test inputs only.
- Shipped plugin code cannot import from `contracts/`, `tooling/`, or a sibling plugin.
- All commands and scripts must work in PowerShell on native Windows.
- Use argument arrays for child processes.
- Use TDD and commit after every task.

---

## File map

| Path | Responsibility |
|---|---|
| `package.json` | Root scripts, Node floor, development dependencies |
| `.gitignore` | Generated output, temporary artifacts, logs, editor files |
| `LICENSE` | Apache-2.0 root license |
| `contracts/types/relay.d.ts` | Canonical contract type names |
| `contracts/schemas/common.schema.json` | Provider, status, timestamps, safety definitions |
| `contracts/schemas/job.schema.json` | Durable job record schema |
| `contracts/schemas/result.schema.json` | Terminal result envelope schema |
| `contracts/schemas/lease.schema.json` | Cross-provider advisory lease schema |
| `contracts/fixtures/*.json` | Valid and invalid contract examples |
| `tooling/lib/fs-walk.mjs` | Deterministic recursive file discovery |
| `tooling/sync-contracts.mjs` | Copy schemas/types into plugin artifacts |
| `tooling/check-plugin-isolation.mjs` | Reject runtime imports outside a plugin |
| `tooling/check-forbidden-flags.mjs` | Reject unsafe default provider flags |
| `tests/foundation/*.test.mjs` | Root metadata tests |
| `tests/contract/*.test.mjs` | Ajv schema and fixture tests |
| `tests/tooling/*.test.mjs` | Contract sync and packaging-policy tests |

### Task 1: Initialize the repository and root test harness

**Files:**
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `package.json`
- Create: `tests/foundation/root-metadata.test.mjs`
- Generate: `package-lock.json`

**Interfaces:**
- Consumes: approved design specification.
- Produces: `npm test`, Node `>=20`, root Apache-2.0 metadata.

- [ ] **Step 1: Verify the isolated feature worktree**

Run:

```powershell
git rev-parse --show-toplevel
git branch --show-current
git status --short
```

Expected: the repository root ends in `.worktrees\agent-relay-marketplace`, the branch is `feature/agent-relay-marketplace`, and the status is empty.

- [ ] **Step 2: Write the failing root metadata test**

Create `tests/foundation/root-metadata.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("root package fixes the runtime floor and license", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.test, "node --test");
});

test("root license is Apache-2.0", () => {
  const license = fs.readFileSync(new URL("../../LICENSE", import.meta.url), "utf8");
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0, January 2004/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```powershell
node --test tests/foundation/root-metadata.test.mjs
```

Expected: non-zero exit with `ENOENT` for `package.json`.

- [ ] **Step 4: Add the minimal root metadata**

Create `package.json`:

```json
{
  "name": "@hotaru-ritsuki/agent-relay-marketplace",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Claude Code marketplace for independent Codex Relay and Cursor Relay plugins.",
  "license": "Apache-2.0",
  "engines": {
    "node": ">=20"
  },
  "workspaces": [
    "plugins/cdx-relay",
    "plugins/cursor-relay"
  ],
  "scripts": {
    "test": "node --test",
    "sync-contracts": "node tooling/sync-contracts.mjs",
    "check:isolation": "node tooling/check-plugin-isolation.mjs",
    "check:safety": "node tooling/check-forbidden-flags.mjs",
    "check": "npm test && npm run check:isolation && npm run check:safety"
  },
  "devDependencies": {
    "@types/node": "^25.5.0",
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "typescript": "^6.0.2"
  }
}
```

Create `.gitignore`:

```gitignore
.worktrees/
.superpowers/
node_modules/
.scratch/
.tmp/
coverage/
dist/
*.log
*.tmp
*.pid
.DS_Store
Thumbs.db
```

Copy the authoritative Apache-2.0 text:

```powershell
Copy-Item -LiteralPath "D:\PersonalProjects\codex-cc-relay-plugin\LICENSE" -Destination "LICENSE"
npm install
```

Expected: `package-lock.json` is generated and npm exits 0.

- [ ] **Step 5: Run the test to verify it passes**

Run:

```powershell
node --test tests/foundation/root-metadata.test.mjs
```

Expected: 2 tests pass, 0 fail.

- [ ] **Step 6: Commit**

```powershell
git add .gitignore LICENSE package.json package-lock.json tests/foundation/root-metadata.test.mjs
git commit -m "chore: initialize agent relay monorepo"
```

### Task 2: Define and validate the shared contract schemas

**Files:**
- Create: `contracts/types/relay.d.ts`
- Create: `contracts/schemas/common.schema.json`
- Create: `contracts/schemas/job.schema.json`
- Create: `contracts/schemas/result.schema.json`
- Create: `contracts/schemas/lease.schema.json`
- Create: `contracts/fixtures/job.completed.json`
- Create: `contracts/fixtures/result.completed.json`
- Create: `contracts/fixtures/lease.cursor.json`
- Create: `contracts/fixtures/job.invalid-status.json`
- Create: `tests/contract/schemas.test.mjs`

**Interfaces:**
- Consumes: Ajv development dependency.
- Produces: `RelayProvider`, `JobStatus`, `SafetyPolicy`, `JobRecord`, `ResultEnvelope`, `WorkspaceLease`; JSON Schema IDs under `https://agent-relay.dev/schemas/v1/`.

- [ ] **Step 1: Write the failing schema test**

Create `tests/contract/schemas.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

const schemas = [
  "contracts/schemas/common.schema.json",
  "contracts/schemas/job.schema.json",
  "contracts/schemas/result.schema.json",
  "contracts/schemas/lease.schema.json"
].map(readJson);

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);

test("valid contract fixtures satisfy their schemas", () => {
  for (const [schemaId, fixture] of [
    ["https://agent-relay.dev/schemas/v1/job", "contracts/fixtures/job.completed.json"],
    ["https://agent-relay.dev/schemas/v1/result", "contracts/fixtures/result.completed.json"],
    ["https://agent-relay.dev/schemas/v1/lease", "contracts/fixtures/lease.cursor.json"]
  ]) {
    const validate = ajv.getSchema(schemaId);
    assert.ok(validate, `missing ${schemaId}`);
    assert.equal(validate(readJson(fixture)), true, JSON.stringify(validate.errors));
  }
});

test("unknown job statuses are rejected", () => {
  const validate = ajv.getSchema("https://agent-relay.dev/schemas/v1/job");
  assert.equal(validate(readJson("contracts/fixtures/job.invalid-status.json")), false);
  assert.match(JSON.stringify(validate.errors), /status/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm test -- tests/contract/schemas.test.mjs
```

Expected: non-zero exit with `ENOENT` for `contracts/schemas/common.schema.json`.

- [ ] **Step 3: Add the canonical TypeScript declarations**

Create `contracts/types/relay.d.ts`:

```ts
export type RelayProvider = "codex" | "cursor";
export type JobStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted"
  | "partial";
export type RetrySafety = "safe" | "unsafe" | "unknown";

export interface SafetyPolicy {
  sandbox: string;
  readOnly: boolean;
  network: boolean;
  mcp: boolean;
  approvals: "deny" | "prompt" | "explicit-policy";
  allowConcurrentWrites: boolean;
}

export interface JobRecord {
  schemaVersion: 1;
  provider: RelayProvider;
  pluginVersion: string;
  jobId: string;
  claudeSessionId: string | null;
  workspaceHash: string;
  transport: string;
  model: string;
  safety: SafetyPolicy;
  status: JobStatus;
  providerStatus: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ResultEnvelope {
  schemaVersion: 1;
  provider: RelayProvider;
  pluginVersion: string;
  jobId: string;
  status: JobStatus;
  retrySafety: RetrySafety;
  summary: string;
  finalOutput: string;
  changedFiles: string[];
  error: { code: string; message: string } | null;
}

export interface WorkspaceLease {
  schemaVersion: 1;
  provider: RelayProvider;
  jobId: string;
  workspaceHash: string;
  pid: number;
  processStartedAt: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
}
```

- [ ] **Step 4: Add the JSON Schemas and fixtures**

Create `contracts/schemas/common.schema.json`:

```json
{
  "$id": "https://agent-relay.dev/schemas/v1/common",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "provider": { "enum": ["codex", "cursor"] },
    "status": {
      "enum": ["queued", "starting", "running", "waiting", "completed", "failed", "cancelled", "timed_out", "interrupted", "partial"]
    },
    "retrySafety": { "enum": ["safe", "unsafe", "unknown"] },
    "timestamp": { "type": "string", "format": "date-time" },
    "nullableTimestamp": {
      "oneOf": [
        { "$ref": "#/$defs/timestamp" },
        { "type": "null" }
      ]
    },
    "safety": {
      "type": "object",
      "additionalProperties": false,
      "required": ["sandbox", "readOnly", "network", "mcp", "approvals", "allowConcurrentWrites"],
      "properties": {
        "sandbox": { "type": "string", "minLength": 1 },
        "readOnly": { "type": "boolean" },
        "network": { "type": "boolean" },
        "mcp": { "type": "boolean" },
        "approvals": { "enum": ["deny", "prompt", "explicit-policy"] },
        "allowConcurrentWrites": { "type": "boolean" }
      }
    }
  }
}
```

Create `contracts/schemas/job.schema.json`:

```json
{
  "$id": "https://agent-relay.dev/schemas/v1/job",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": true,
  "required": ["schemaVersion", "provider", "pluginVersion", "jobId", "claudeSessionId", "workspaceHash", "transport", "model", "safety", "status", "providerStatus", "createdAt", "updatedAt", "startedAt", "finishedAt"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "provider": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/provider" },
    "pluginVersion": { "type": "string", "minLength": 1 },
    "jobId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{7,127}$" },
    "claudeSessionId": { "type": ["string", "null"] },
    "workspaceHash": { "type": "string", "pattern": "^[a-f0-9]{16}$" },
    "transport": { "type": "string", "minLength": 1 },
    "model": { "type": "string", "minLength": 1 },
    "safety": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/safety" },
    "status": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/status" },
    "providerStatus": { "type": ["string", "null"] },
    "createdAt": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/timestamp" },
    "updatedAt": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/timestamp" },
    "startedAt": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/nullableTimestamp" },
    "finishedAt": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/nullableTimestamp" }
  }
}
```

Create `contracts/schemas/result.schema.json`:

```json
{
  "$id": "https://agent-relay.dev/schemas/v1/result",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": true,
  "required": ["schemaVersion", "provider", "pluginVersion", "jobId", "status", "retrySafety", "summary", "finalOutput", "changedFiles", "error"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "provider": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/provider" },
    "pluginVersion": { "type": "string", "minLength": 1 },
    "jobId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{7,127}$" },
    "status": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/status" },
    "retrySafety": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/retrySafety" },
    "summary": { "type": "string" },
    "finalOutput": { "type": "string" },
    "changedFiles": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
    "error": {
      "oneOf": [
        { "type": "null" },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["code", "message"],
          "properties": {
            "code": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]+$" },
            "message": { "type": "string" }
          }
        }
      ]
    }
  }
}
```

Create `contracts/schemas/lease.schema.json`:

```json
{
  "$id": "https://agent-relay.dev/schemas/v1/lease",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "provider", "jobId", "workspaceHash", "pid", "processStartedAt", "nonce", "createdAt", "expiresAt"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "provider": { "$ref": "https://agent-relay.dev/schemas/v1/common#/$defs/provider" },
    "jobId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{7,127}$" },
    "workspaceHash": { "type": "string", "pattern": "^[a-f0-9]{16}$" },
    "pid": { "type": "integer", "minimum": 1 },
    "processStartedAt": { "type": "string", "format": "date-time" },
    "nonce": { "type": "string", "minLength": 16 },
    "createdAt": { "type": "string", "format": "date-time" },
    "expiresAt": { "type": "string", "format": "date-time" }
  }
}
```

Create the four fixtures using the exact field names above. Use:

```json
{
  "schemaVersion": 1,
  "provider": "codex",
  "pluginVersion": "1.2.0",
  "jobId": "job-00000001",
  "claudeSessionId": "claude-1",
  "workspaceHash": "0123456789abcdef",
  "transport": "app-server",
  "model": "gpt-5.6-sol",
  "safety": {
    "sandbox": "workspace-write",
    "readOnly": false,
    "network": false,
    "mcp": false,
    "approvals": "prompt",
    "allowConcurrentWrites": false
  },
  "status": "completed",
  "providerStatus": "turn/completed",
  "createdAt": "2026-07-23T00:00:00.000Z",
  "updatedAt": "2026-07-23T00:01:00.000Z",
  "startedAt": "2026-07-23T00:00:01.000Z",
  "finishedAt": "2026-07-23T00:01:00.000Z"
}
```

`result.completed.json` uses `provider: "cursor"`, `jobId: "job-00000002"`, `status: "completed"`, `retrySafety: "unknown"`, empty output/error collections, and `pluginVersion: "1.0.0"`. `lease.cursor.json` uses `provider: "cursor"`, `jobId: "job-00000002"`, `workspaceHash: "0123456789abcdef"`, `pid: 1234`, a 16-character nonce, and valid timestamps. `job.invalid-status.json` copies `job.completed.json` and sets `"status": "done"`.

- [ ] **Step 5: Run the schema test to verify it passes**

Run:

```powershell
npm test -- tests/contract/schemas.test.mjs
```

Expected: 2 tests pass, 0 fail.

- [ ] **Step 6: Commit**

```powershell
git add contracts tests/contract
git commit -m "feat: define relay lifecycle contracts"
```

### Task 3: Synchronize contract artifacts into isolated plugins

**Files:**
- Create: `tooling/lib/fs-walk.mjs`
- Create: `tooling/sync-contracts.mjs`
- Create: `tests/tooling/sync-contracts.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `syncContracts({ rootDir, pluginDirs })`.
- Produces: exact copies under `<plugin>/schemas/agent-relay/` and `<plugin>/types/relay.d.ts`.

- [ ] **Step 1: Write the failing synchronization test**

Create `tests/tooling/sync-contracts.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncContracts } from "../../tooling/sync-contracts.mjs";

test("syncContracts copies schemas and declarations into each plugin", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-"));
  const rootDir = fileURLToPath(new URL("../..", import.meta.url));
  const pluginDirs = [path.join(temp, "cdx-relay"), path.join(temp, "cursor-relay")];
  syncContracts({ rootDir, pluginDirs });

  for (const pluginDir of pluginDirs) {
    assert.equal(
      fs.readFileSync(path.join(pluginDir, "types", "relay.d.ts"), "utf8"),
      fs.readFileSync(path.join(rootDir, "contracts", "types", "relay.d.ts"), "utf8")
    );
    assert.ok(fs.existsSync(path.join(pluginDir, "schemas", "agent-relay", "job.schema.json")));
    assert.ok(fs.existsSync(path.join(pluginDir, "schemas", "agent-relay", "result.schema.json")));
    assert.ok(fs.existsSync(path.join(pluginDir, "schemas", "agent-relay", "lease.schema.json")));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm test -- tests/tooling/sync-contracts.test.mjs
```

Expected: non-zero exit because `tooling/sync-contracts.mjs` does not exist.

- [ ] **Step 3: Implement deterministic file discovery and synchronization**

Create `tooling/lib/fs-walk.mjs`:

```js
import fs from "node:fs";
import path from "node:path";

export function listFiles(rootDir) {
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const absolute = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files.sort((left, right) => left.localeCompare(right));
}
```

Create `tooling/sync-contracts.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./lib/fs-walk.mjs";

export function syncContracts({ rootDir, pluginDirs }) {
  const schemaRoot = path.join(rootDir, "contracts", "schemas");
  const typeFile = path.join(rootDir, "contracts", "types", "relay.d.ts");
  for (const pluginDir of pluginDirs) {
    const schemaTarget = path.join(pluginDir, "schemas", "agent-relay");
    const typeTarget = path.join(pluginDir, "types");
    fs.mkdirSync(schemaTarget, { recursive: true });
    fs.mkdirSync(typeTarget, { recursive: true });
    for (const source of listFiles(schemaRoot)) {
      fs.copyFileSync(source, path.join(schemaTarget, path.basename(source)));
    }
    fs.copyFileSync(typeFile, path.join(typeTarget, "relay.d.ts"));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  syncContracts({
    rootDir,
    pluginDirs: [
      path.join(rootDir, "plugins", "cdx-relay"),
      path.join(rootDir, "plugins", "cursor-relay")
    ]
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```powershell
npm test -- tests/tooling/sync-contracts.test.mjs
```

Expected: 1 test passes, 0 fail.

- [ ] **Step 5: Commit**

```powershell
git add tooling package.json tests/tooling/sync-contracts.test.mjs
git commit -m "build: synchronize plugin contract artifacts"
```

### Task 4: Enforce plugin isolation and safe provider defaults

**Files:**
- Create: `tooling/check-plugin-isolation.mjs`
- Create: `tooling/check-forbidden-flags.mjs`
- Create: `tests/tooling/policy-checks.test.mjs`

**Interfaces:**
- Consumes: `checkPluginIsolation(pluginDir)` and `checkForbiddenFlags(pluginDir)`.
- Produces: arrays of `{ file, message }`; CLI exits 1 when any violation exists.

- [ ] **Step 1: Write failing policy tests**

Create `tests/tooling/policy-checks.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPluginIsolation } from "../../tooling/check-plugin-isolation.mjs";
import { checkForbiddenFlags } from "../../tooling/check-forbidden-flags.mjs";

function fixture(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-policy-"));
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, "runtime.mjs"), source);
  return root;
}

test("isolation rejects imports that leave the plugin", () => {
  const violations = checkPluginIsolation(fixture('import "../../contracts/runtime.mjs";'));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /outside plugin/);
});

test("safety scan rejects unsafe default flags", () => {
  const violations = checkForbiddenFlags(fixture('const defaults = ["--force", "--trust"];'));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /--force/);
  assert.match(violations[0].message, /--trust/);
});

test("safe runtime sources pass both policies", () => {
  const root = fixture('import "./local.mjs"; const args = ["--sandbox", "enabled"];');
  fs.writeFileSync(path.join(root, "scripts", "local.mjs"), "export default true;");
  assert.deepEqual(checkPluginIsolation(root), []);
  assert.deepEqual(checkForbiddenFlags(root), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm test -- tests/tooling/policy-checks.test.mjs
```

Expected: non-zero exit because both tooling modules are absent.

- [ ] **Step 3: Implement the isolation checker**

Create `tooling/check-plugin-isolation.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./lib/fs-walk.mjs";

const IMPORT = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;

export function checkPluginIsolation(pluginDir) {
  const root = path.resolve(pluginDir);
  const violations = [];
  for (const file of listFiles(root).filter((item) => {
    const relative = path.relative(root, item).split(path.sep).join("/");
    return /\.(?:mjs|js|cjs)$/.test(item)
      && !relative.startsWith("tests/")
      && !relative.startsWith("tooling/");
  })) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      if (!match[1].startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), match[1]);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        violations.push({ file, message: `relative import leaves plugin: ${match[1]}` });
      }
    }
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = ["cdx-relay", "cursor-relay"].flatMap((name) =>
    checkPluginIsolation(path.join(root, "plugins", name))
  );
  if (violations.length) {
    for (const violation of violations) console.error(`${violation.file}: ${violation.message}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Implement the forbidden-default checker**

Create `tooling/check-forbidden-flags.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "./lib/fs-walk.mjs";

const FORBIDDEN = ["--force", "--yolo", "--trust", "--approve-mcps", "--dangerously-bypass-approvals-and-sandbox"];

export function checkForbiddenFlags(pluginDir) {
  const violations = [];
  const root = path.resolve(pluginDir);
  for (const file of listFiles(root).filter((item) => {
    const relative = path.relative(root, item).split(path.sep).join("/");
    return /\.(?:md|json|mjs|js|cjs)$/.test(item)
      && !relative.startsWith("tests/")
      && !relative.startsWith("tooling/")
      && !["CHANGELOG.md", "NOTICE", "PROVENANCE.md"].includes(relative);
  })) {
    const source = fs.readFileSync(file, "utf8");
    const found = FORBIDDEN.filter((flag) => source.includes(`"${flag}"`) || source.includes(`'${flag}'`));
    if (found.length) violations.push({ file, message: `unsafe defaults present: ${found.join(", ")}` });
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = ["cdx-relay", "cursor-relay"].flatMap((name) =>
    checkForbiddenFlags(path.join(root, "plugins", name))
  );
  if (violations.length) {
    for (const violation of violations) console.error(`${violation.file}: ${violation.message}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 5: Run policy tests to verify they pass**

Run:

```powershell
npm test -- tests/tooling/policy-checks.test.mjs
```

Expected: 3 tests pass, 0 fail.

- [ ] **Step 6: Run the complete foundation gate**

Run:

```powershell
npm test
```

Expected: all foundation, contract, and tooling tests pass with 0 failures.

- [ ] **Step 7: Commit**

```powershell
git add tooling tests/tooling
git commit -m "test: enforce plugin isolation and safe defaults"
```

## Foundation completion gate

Run:

```powershell
npm test
git status --short
```

Expected: all tests pass and `git status --short` is empty.
