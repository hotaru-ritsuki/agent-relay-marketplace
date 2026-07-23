# Agent Relay Marketplace Design

Date: 2026-07-23  
Status: conversational design approved; awaiting review of this written specification  
Research basis: `AGENT_RELAY_MARKETPLACE_RESEARCH.md`

## 1. Executive summary

Agent Relay Marketplace is a Claude Code marketplace containing two independently installable provider plugins:

- `cdx-relay`, displayed as **Codex Relay**, with commands under `/cdx-relay:*`
- `cursor-relay`, displayed as **Cursor Relay**, with commands under `/cursor-relay:*`

The marketplace is a catalog and packaging repository. It is not a relay runtime, broker, authentication layer, provider selector, or state owner. It exposes no `/agent-relay:*` commands.

The source uses a monorepo because the existing `hotaru-ritsuki/codex-relay-plugin` is now a standalone GitHub repository rather than a GitHub-network fork. Codex Relay will be imported with its relevant history, Apache-2.0 license, NOTICE, and attribution. Cursor Relay will be implemented cleanly.

Although the source is a monorepo, the installed plugins remain operationally independent. Each plugin has its own manifest, version, commands, hooks, transport, configuration, authentication checks, state, migrations, tests, and release tag. An installed plugin cannot import runtime code from the repository root or the other plugin.

Cursor Relay v1 uses the authenticated local Cursor Agent CLI. Cursor SDK, cloud runs, API-key authentication, and token billing are deferred. Codex Relay preserves its app-server transport and all existing commands while adding the common relay vocabulary.

## 2. Goals

The design must provide:

1. Two provider-specific Claude Code plugins with no third runtime plugin.
2. Independent installation, configuration, authentication, state, failure handling, versioning, release, and uninstall behavior.
3. A common user-facing lifecycle and result contract without erasing provider-specific capabilities.
4. Safe foreground and background delegation, status, results, cancellation, and resume.
5. Enforced read-only review behavior where a review command is exposed.
6. Native Windows support as a release gate.
7. Compatibility with the current Codex Relay command surface.
8. A clean Cursor Relay implementation based on current Cursor CLI behavior rather than stale reference assumptions.
9. Bounded, redacted state and logs with recoverable concurrent writes.
10. Independent releases from one source repository.

## 3. Non-goals

V1 will not provide:

- A marketplace-level runtime, broker, state store, authentication store, hook, or command.
- `/agent-relay:*` commands.
- Automatic provider choice, load balancing, or provider failover.
- Automatic transport fallback after a job starts.
- Cursor SDK, cloud agents, API-key authentication, or SDK token billing.
- A blocking Cursor Stop hook.
- Default permission bypass, full-access execution, workspace auto-trust, automatic MCP approval, or disabled sandboxing.
- A runtime package shared by both installed plugins.
- Git submodules.
- Permanent hard-coded provider model catalogs.
- Guaranteed safe simultaneous mutation of one workspace without a valid advisory lease or explicit override.

## 4. Approved decisions

The following decisions are final for this design:

| Decision | Approved choice |
|---|---|
| Repository strategy | One monorepo |
| Plugin isolation | Self-contained installed artifacts |
| Codex source treatment | History-preserving import; no GitHub fork-network requirement |
| Cursor v1 transport | Authenticated local Cursor CLI |
| Cursor SDK | Deferred beyond v1 |
| Existing Codex commands | Preserved in v1 |
| Codex Stop review gate | Available, disabled by default |
| Cursor Stop review gate | Not shipped in v1 |
| Root and new Cursor license | Apache-2.0 |
| Reused MIT material | Retain required attribution |
| Submodules | Not used |

## 5. Repository architecture

```text
agent-relay-marketplace/
├── .claude-plugin/
│   └── marketplace.json
├── contracts/
│   ├── schemas/
│   └── fixtures/
├── docs/
├── plugins/
│   ├── cdx-relay/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── commands/
│   │   ├── skills/
│   │   ├── hooks/
│   │   ├── scripts/
│   │   ├── tests/
│   │   ├── CHANGELOG.md
│   │   ├── LICENSE
│   │   ├── NOTICE
│   │   └── PROVENANCE.md
│   └── cursor-relay/
│       ├── .claude-plugin/plugin.json
│       ├── commands/
│       ├── skills/
│       ├── hooks/
│       ├── scripts/
│       ├── tests/
│       ├── CHANGELOG.md
│       ├── LICENSE
│       ├── NOTICE
│       └── PROVENANCE.md
├── tests/
│   ├── contract/
│   ├── marketplace/
│   ├── packaging/
│   └── windows/
├── tooling/
├── CHANGELOG.md
├── LICENSE
└── README.md
```

The marketplace identity is `agent-relay-marketplace`. Its catalog contains exactly two strict relative-source entries:

- `cdx-relay` from `./plugins/cdx-relay`
- `cursor-relay` from `./plugins/cursor-relay`

The plugin manifests are authoritative. Marketplace entries do not duplicate plugin versions.

### 5.1 Source import

The current standalone Codex repository contains its plugin beneath `plugins/codex`. The monorepo will import a history-preserving split of that plugin subtree into `plugins/cdx-relay`; it will not nest the old marketplace repository inside the new plugin directory. Root-level source tests that remain relevant will be relocated into the imported plugin or monorepo test directories with their provenance retained.

The import records:

- Source repository URL.
- Source commit `9000f8fbfcf846531b2a8bce4756cfe2d2798b52`.
- Inspected OpenAI upstream base `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Import method and date.
- Apache-2.0 and NOTICE obligations.

## 6. Isolation contract

Source colocation must not create runtime coupling.

Each plugin:

- Is installable from its directory alone.
- Uses only files contained in its packaged directory at runtime.
- Has its own `package.json` if one is needed.
- Has its own manifest version and changelog.
- Uses only its own `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}`.
- Never reads or modifies the other provider’s configuration or job records.
- Never requires the other provider binary, authentication, or plugin installation.
- Can be disabled or uninstalled without breaking the other plugin.

The root `contracts/` directory contains JSON Schemas, lifecycle definitions, and fixtures. Build tooling may copy or generate contract artifacts into a plugin before packaging. Shipped plugin code may not import from `contracts/`, `tooling/`, the repository root, or the sibling plugin.

An artifact-isolation test copies one plugin into an otherwise empty temporary directory and runs its validation and test entrypoints there. A packaging check rejects path traversal and cross-plugin imports.

The shipped runtime uses Node.js ESM. Runtime files are executable JavaScript with Node built-ins where practical; TypeScript types and schemas may be used at build and test time. The initial runtime target is Node.js 20 or newer, with Node.js 22 included in the release matrix.

## 7. Component model

Each plugin contains the same conceptual layers but implements them independently.

### 7.1 Command layer

Claude Code skills and compatibility commands parse `$ARGUMENTS`, validate the user request, invoke the plugin controller, and render a compact human result. They contain no transport or persistence logic.

### 7.2 Controller

The controller:

- Resolves the canonical workspace.
- Loads provider-specific configuration.
- Runs preflight checks.
- Creates durable job records.
- Acquires mutation leases.
- Selects the explicitly configured transport.
- Connects transport events to the state store.
- Terminalizes the job exactly once.

### 7.3 Transport adapter

A provider transport exposes a provider-local interface for:

- Capability and version detection.
- Authentication status.
- Start.
- Stream.
- Resume.
- Interrupt.
- Dispose.

The interface is conceptually common, but no runtime implementation is shared between plugins.

### 7.4 State store

The state store owns schema validation, atomic writes, event appends, locks, retention, quarantine, and provider-local migrations.

### 7.5 Platform process adapter

The process adapter owns executable discovery, argument-array spawning, process identity, graceful termination, Windows process-tree termination, and timeout escalation.

### 7.6 Hooks and notifications

Hooks are provider-scoped. Completion reporting is non-blocking. Only Codex may install an opt-in Stop review gate.

## 8. Command and UX contract

### 8.1 Common commands

Both plugins expose:

```text
/<provider>:delegate <task> [--background]
/<provider>:status [job-id] [--all]
/<provider>:result <job-id>
/<provider>:cancel <job-id>
/<provider>:resume <job-id> [additional instructions]
/<provider>:doctor
/<provider>:setup
```

`<provider>` is exactly `cdx-relay` or `cursor-relay`.

| Command | Contract |
|---|---|
| `delegate` | Starts a new provider job. It waits by default; `--background` returns after durable launch. |
| `status` | Shows current-Claude-session jobs by default. A job ID selects one job; `--all` shows the current workspace. |
| `result` | Requires a job ID and returns the normalized result plus provider-native detail. |
| `cancel` | Requires a job ID, requests provider-native interruption, and escalates safely when necessary. |
| `resume` | Resumes the provider session and creates a linked child job record. |
| `doctor` | Performs read-only binary, version, authentication, model, sandbox, state, and Windows checks for one provider. |
| `setup` | Writes configuration only for the invoked provider and offers provider-specific migration where applicable. |

The namespace is the routing decision. No command automatically chooses another provider.

Every job start produces a receipt containing:

- Provider and plugin version.
- Job ID.
- Transport.
- Model.
- Safety mode.
- Foreground or background mode.
- Exact status, result, and cancel follow-up commands.

### 8.2 Provider-specific commands

Codex Relay preserves all commands present in version 1.1.6, including:

- `rescue`
- `transfer`
- `review`
- `adversarial-review`
- Existing setup, status, result, and cancellation behavior

Compatibility commands keep their established semantics during v1. The common commands are additive.

Two Codex compatibility exceptions are explicit:

- `/cdx-relay:result` without a job ID retains the v1.1.6 resolver for the latest eligible completed job in the current Claude session.
- `/cdx-relay:cancel` without a job ID retains the v1.1.6 behavior only when one active job is unambiguous; multiple active jobs require an explicit ID.

Cursor Relay and all deterministic cross-provider examples require job IDs for `result` and `cancel`. Receipts always print the explicit-ID form.

Cursor Relay may expose `review` in v1 only when its acceptance gate proves enforced ask/read-only mode, sandboxing, workspace containment, and a post-run no-write check against the supported native Windows CLI. If that gate fails, the command is absent rather than weakened to prompt-only review.

Separate `delegate-async`, `sessions`, and `from-plan` commands are excluded. Their use cases are covered by `delegate --background`, `status --all`, and ordinary task input.

## 9. Provider transports

### 9.1 Codex Relay

The primary Codex transport is the existing persistent `codex app-server` broker.

The broker:

- Is owned by `cdx-relay`.
- Stores endpoint and lifecycle data under `cdx-relay` plugin data.
- Reuses a broker per canonical workspace when healthy.
- Initializes the app-server protocol before accepting work.
- Tracks Codex thread and turn identifiers.
- Supports native `turn/interrupt`.
- Preserves provider-native streamed events.

Because app-server is experimental, the adapter performs:

- Codex CLI version detection.
- Protocol initialization and capability checks.
- Schema compatibility checks.
- Generated-protocol validation against the tested CLI matrix.
- Fail-closed behavior for unsupported methods or event shapes.

`codex exec` remains an explicitly selected one-shot transport for suitable isolated work. It is never an automatic fallback for an app-server job.

### 9.2 Cursor Relay

Cursor Relay v1 invokes the authenticated local Cursor Agent CLI.

The adapter:

- Discovers supported native executable forms, including Windows command shims.
- Confirms login status without exposing account identifiers.
- Reads the live model catalog.
- Explicitly selects `composer-2.5` as the default model.
- Uses explicit structured or streaming output flags rather than relying on changing defaults.
- Supports CLI resume/continue behavior through stored provider session identifiers.
- Does not pass the removed legacy `--cloud` option.

The plugin never injects `--force`, `--yolo`, `--trust`, disabled sandboxing, or automatic MCP approval by default.

Cursor SDK, local SDK agents, cloud SDK agents, SDK persistence, API keys, and SDK billing are deferred to a future design.

## 10. Authentication, trust, and safety

Each plugin uses provider-native authentication.

- Codex Relay uses the local Codex authentication state.
- Cursor Relay uses the local Cursor CLI login and subscription behavior.
- Credentials are never copied into plugin configuration, job state, event logs, or result envelopes.
- Future API-key support requires a separate design and may only use environment or provider-native credential facilities.

Workspace trust is provider-managed. `setup` may explain how to establish trust, but it does not silently pass trust-granting flags. A job blocked on trust becomes `waiting` with a safe actionable message.

### 10.1 Normal delegation

Normal jobs use provider sandboxing restricted to the canonical workspace. A request for a more permissive mode must be explicit and is recorded in the result.

### 10.2 Review

A read-only review requires all of:

1. Provider read-only or ask mode.
2. Provider or OS sandbox enforcement.
3. Canonical workspace containment.
4. No automatic approval or trust grant.
5. A baseline and final workspace comparison.

Prompt instructions alone are not a security boundary. If any required control is unavailable, review fails closed.

### 10.3 Network and MCP

The job record states whether network and MCP access were enabled. The plugins do not auto-approve MCP tools. Approval events become `waiting` unless an explicit, recorded policy permits the action.

### 10.4 Secret and log handling

Operational logs are structured, bounded, and redacted. Raw provider streams are off by default. Diagnostic capture requires explicit opt-in, applies redaction, and expires after seven days.

## 11. Execution data flow

Every command follows this sequence:

1. Parse and validate arguments.
2. Resolve the canonical workspace and plugin-specific configuration.
3. Detect binary, version, authentication, model, capabilities, trust, and sandbox readiness.
4. Determine whether the job is read-only or mutating.
5. Acquire the required advisory lease.
6. Write a durable `queued` record before launching a provider process.
7. Fix the transport, model, and safety policy for the job.
8. Launch with an argument array rather than a shell-built command.
9. Move through `starting` and `running` while appending normalized and provider-native events.
10. Enter `waiting` for recoverable external conditions.
11. Terminalize the result exactly once.
12. Release the lease and emit an optional non-blocking notification.

Foreground commands stream progress and wait for the result. Background commands return only after the durable job exists and the launch outcome is known.

`status` and `result` read stored state. They do not reconnect, resume, retry, or otherwise mutate a provider implicitly.

No job changes transport after launch. A possibly mutating request is never automatically retried through another transport.

## 12. Concurrency and workspace leases

Each plugin allows:

- Multiple concurrent read-only jobs.
- One mutating job per canonical workspace by default.

To prevent Codex and Cursor from mutating the same workspace concurrently, both plugins implement the same ephemeral advisory-lease format:

- Git workspace: lease data under the Git common metadata directory.
- Non-Git workspace: lease data under an OS temporary directory keyed by the canonical workspace hash.

A lease contains:

- Provider.
- Job ID.
- PID.
- Process creation time.
- Random launch nonce.
- Creation and expiry timestamps.
- Canonical workspace hash.

A plugin does not read or modify the other provider’s job state. It reads only the neutral lease protocol. Stale leases are ignored only after process identity and expiry validation. This prevents a crashed or uninstalled plugin from permanently blocking the other.

`--allow-concurrent-writes` is an explicit override. Its use is recorded in the job receipt and result.

Each mutating or review job records a baseline and final workspace snapshot. Existing user changes are not treated as provider changes; the result reports only the observed delta. If unrelated concurrent changes make attribution unsafe, the job becomes `partial` or `failed` with `CONCURRENT_MUTATION`.

## 13. State and persistence

Each plugin uses its own Claude plugin data directory:

```text
${CLAUDE_PLUGIN_DATA}/
├── config.json
├── workspaces/<canonical-workspace-hash>/
│   ├── workspace.json
│   ├── jobs/<job-id>/
│   │   ├── metadata.json
│   │   ├── events.jsonl
│   │   ├── result.json
│   │   └── process.json
│   └── locks/
└── migrations/
```

Configuration may contain provider defaults and workspace overrides, but never credentials.

The normalized lifecycle is:

```text
queued → starting → running ↔ waiting
                           ├→ completed
                           ├→ failed
                           ├→ cancelled
                           ├→ timed_out
                           ├→ interrupted
                           └→ partial
```

Terminal-state definitions:

- `completed`: the requested contract was satisfied.
- `failed`: the provider or plugin terminated with no acceptable result.
- `cancelled`: user cancellation was confirmed or locally enforced.
- `timed_out`: the deadline expired and the stop sequence completed.
- `interrupted`: the provider or controller disappeared unexpectedly.
- `partial`: useful output or artifacts exist, but completion cannot be claimed.

Provider-native status and phase remain alongside the normalized state.

### 13.1 Write integrity

- Per-job files minimize contention.
- Metadata and results use owner-token locks and atomic replacement.
- Windows rename failures receive bounded retry.
- Event files are append-only JSONL.
- Terminalization is compare-and-set and may occur only once.
- Corrupt files are quarantined with diagnostics rather than overwritten.
- Schema migrations are plugin-specific, versioned, and journaled.

### 13.2 Retention

Default retention is 30 days or 200 jobs per workspace, whichever limit is reached first. Pinned or active jobs are not pruned. Diagnostic raw streams expire after seven days.

## 14. Result envelope

The shared result schema contains:

```text
schemaVersion
provider
pluginVersion
jobId
parentJobId
resumedFromJobId
claudeSessionId
workspace
transport
providerVersion
providerSession
model
safety
timestamps
status
providerStatus
output
artifacts
changedFiles
verification
cancellation
error
retrySafety
```

Important nested fields include:

- `workspace.canonicalPath`, `workspace.hash`, and source-control snapshot identifiers.
- `safety.sandbox`, `safety.readOnly`, `safety.network`, `safety.mcp`, `safety.approvals`, and concurrent-write override.
- `timestamps.createdAt`, `startedAt`, `updatedAt`, and `finishedAt`.
- `output.summary`, bounded final text, and a reference to diagnostic events when enabled.
- `changedFiles` with added, modified, deleted, and attribution-uncertain entries.
- `verification` with commands, exit outcomes, and provider-reported evidence.
- `retrySafety` with `safe`, `unsafe`, or `unknown`.

Provider-specific details live under a namespaced extension object so normalization does not discard capabilities.

## 15. Cancellation and timeouts

Cancellation proceeds through explicit stages:

1. `requested`
2. Provider-native interrupt attempted
3. Provider-confirmed stop, or graceful process termination
4. Verified process-tree termination when necessary
5. Terminal state persisted

Codex uses `turn/interrupt` before terminating its broker or worker process.

Cursor first requests graceful CLI termination. If the process does not stop, the platform adapter escalates.

On Windows, forced termination targets the verified process tree. PID, process creation time, and launch nonce must match the stored identity before escalation. `taskkill /PID <pid> /T /F` is a final fallback, not the first cancellation action.

Timeouts use the same sequence and are stored distinctly from user cancellation.

## 16. Error contract

Errors are structured with a stable code, safe message, redacted provider detail, suggested action, and retry-safety classification.

| Code | Meaning |
|---|---|
| `INVALID_REQUEST` | Command arguments or requested operation are invalid. |
| `CONFIGURATION_REQUIRED` | Provider-specific setup is incomplete. |
| `AUTHENTICATION_REQUIRED` | Provider-native login is absent or expired. |
| `WORKSPACE_NOT_TRUSTED` | The provider requires explicit workspace trust. |
| `CAPABILITY_UNAVAILABLE` | The installed provider lacks a required capability. |
| `UNSUPPORTED_VERSION` | Provider protocol or CLI version is outside the tested range. |
| `SAFETY_POLICY_REJECTED` | The request cannot satisfy the required safety policy. |
| `CONCURRENT_MUTATION` | A conflicting workspace mutation exists or attribution is unsafe. |
| `PROVIDER_FAILURE` | The provider returned a terminal failure. |
| `TRANSPORT_FAILURE` | Launch, stream, protocol, or process communication failed. |
| `STATE_CORRUPTION` | Stored state failed validation and was quarantined. |
| `TIMED_OUT` | The configured deadline expired. |
| `CANCELLED` | Cancellation completed. |
| `INTERNAL_ERROR` | An unexpected plugin failure occurred. |

Recoverable authentication, trust, or approval conditions use `waiting`. Terminal faults use `failed`. Useful incomplete work uses `partial`.

Automatic retries are limited to bounded, non-mutating preflight operations. No provider execution is retried automatically after launch.

## 17. Windows-first requirements

Native Windows is a required release platform.

The implementation must:

- Discover provider executables and Windows command shims without POSIX `which`.
- Spawn with argument arrays and correct Windows quoting.
- Support paths with spaces, Unicode, junctions, and long names.
- Canonicalize paths before workspace-boundary checks.
- Handle Windows file-sharing and rename behavior with bounded retry.
- Validate process identity before tree termination.
- Use native process-tree termination only after graceful provider cancellation.
- Avoid case-sensitive environment assumptions such as treating `PATH` and `Path` as unrelated.
- Avoid POSIX-only detached-process, signal, or shell assumptions.

Git worktree and non-Git workspace behavior are both tested. Review containment tests include junction and symlink escape attempts.

Linux and macOS remain compatibility targets, but a release cannot pass with a failing Windows gate.

## 18. Hooks

The marketplace has no hooks.

Both plugins may provide provider-scoped, non-blocking completion notifications.

Codex Relay retains its optional Stop-time review gate:

- Disabled by default.
- Enabled only by explicit Codex setup.
- Uses `stop_hook_active` or equivalent recursion protection.
- Fails with actionable guidance rather than silently weakening review.
- Does not inspect Cursor state.

Cursor Relay v1 has no blocking Stop hook.

## 19. Versioning and release

Each plugin owns its manifest version and changelog.

Initial monorepo release targets:

- `cdx-relay` 1.2.0, because it adds backwards-compatible common commands and migration support.
- `cursor-relay` 1.0.0.
- Marketplace catalog 1.0.0, represented by repository/tag metadata rather than duplicating plugin manifest versions.

Tags:

- `cdx-relay-vX.Y.Z`
- `cursor-relay-vX.Y.Z`
- `marketplace-vX.Y.Z` when catalog-only changes require a tag

Changing one plugin does not require changing the other plugin’s manifest version.

Release artifacts and gates include:

- Manifest and marketplace validation.
- Isolated plugin packaging.
- Contract-schema validation.
- Unit, integration, and Windows tests.
- License and NOTICE verification.
- Forbidden-flag scanning.
- Dependency and provenance metadata.
- Artifact checksum generation.
- Provider compatibility matrix update.

## 20. Existing Codex Relay migration

The legacy marketplace identity is `codex-cc-relay`; the new marketplace identity is `agent-relay-marketplace`. Claude plugin data identity includes the marketplace identity, so the installations use separate data directories.

Migration rules:

1. `doctor` detects the known legacy plugin/data identity without modifying it.
2. The old and new `cdx-relay` installations must not remain enabled together because their command namespaces collide.
3. `setup` offers an explicit import from the known legacy data directory or a user-supplied path.
4. Import validates the old schema before copying.
5. Compatible configuration and job history are copied into the new plugin’s state and migrated there.
6. Legacy data is never modified or deleted.
7. Secrets are not imported.
8. The import writes a journal and may be repeated safely.
9. Rollback disables the new installation and re-enables the old one.

All existing Codex commands remain available after migration.

## 21. Licensing and provenance

The monorepo root uses Apache-2.0.

- `plugins/cdx-relay` retains Apache-2.0, upstream NOTICE, and modified-file/source provenance.
- `plugins/cursor-relay` uses Apache-2.0.
- Clean implementation is the default for Cursor Relay.
- Any copied MIT-licensed source retains the required copyright and license notice.
- Research inspiration that does not copy code is documented in `PROVENANCE.md`.
- Cursor SDK redistribution terms must be reviewed in a future SDK design before that dependency is introduced.

## 22. Testing strategy

### 22.1 Unit tests

Unit tests cover:

- Argument parsing.
- Configuration precedence.
- State transitions.
- Error mapping.
- Redaction.
- Retention.
- Lock and stale-lock behavior.
- Lease validation.
- Workspace hashing.
- Result normalization.
- Provider-event parsing.

### 22.2 Contract tests

The same fixtures run against both plugin controllers for:

- Job receipts.
- Normalized lifecycle transitions.
- Result envelopes.
- Cancellation stages.
- Error codes.
- Resume linkage.
- Concurrent mutation behavior.

Provider extensions are tested separately.

### 22.3 Transport tests

Controlled fake executables and recorded event fixtures test:

- Successful foreground and background work.
- Authentication and trust failures.
- Streaming.
- Resume.
- Approval waiting.
- Protocol mismatch.
- Malformed output.
- Graceful and forced cancellation.
- Timeout.
- Provider crash.

### 22.4 Artifact isolation

Each plugin is copied by itself to a temporary directory. Validation then proves:

- The manifest loads.
- Every command and hook target exists.
- No runtime path leaves the plugin directory.
- No sibling or root module import exists.
- Provider fakes can execute the controller.

### 22.5 Security tests

Tests deliberately attempt:

- Shell and argument injection.
- Path traversal.
- Symlink and junction workspace escape.
- Secret leakage.
- Review writes.
- Unapproved MCP access.
- Automatic trust or permission bypass.
- Stale PID cancellation.
- Corrupt-state replacement.

### 22.6 Platform and live smoke tests

Windows CI is mandatory. Linux and macOS are compatibility jobs.

Release candidates receive explicit live smoke evidence against the supported Codex and Cursor versions. Authentication is supplied through provider-native test environments; secrets are not stored in the repository or ordinary CI logs.

The initial compatibility baseline includes the inspected local versions:

- Claude Code 2.1.215
- Codex CLI 0.145.0
- Cursor Agent CLI 2026.07.20-8cc9c0b
- Node.js 22.23.1

These are evidence baselines, not permanent hard-coded maximum versions. Each release publishes its tested compatibility matrix, and unsupported protocol versions fail closed.

## 23. Acceptance criteria

The design is implemented only when all of the following are true:

1. Claude validates the marketplace and both plugin manifests.
2. Each plugin installs and operates without the other.
3. Disabling, failing, updating, or uninstalling one plugin does not break the other.
4. No `/agent-relay:*` command exists.
5. All common commands satisfy their documented contracts.
6. Existing Codex v1.1.6 commands remain functional.
7. Codex app-server supports foreground, background, status, result, resume, and native interrupt within the tested matrix.
8. Cursor CLI supports foreground, background, status, result, resume where the CLI provides it, and safe cancellation.
9. Cursor uses CLI login and does not require an SDK API key.
10. Cursor review is either proven read-only by the full gate or omitted.
11. Normal delegation never defaults to bypass, force, yolo, trust, disabled sandbox, or automatic MCP approval.
12. Jobs survive controller restarts and terminalize exactly once.
13. Concurrent mutating jobs are blocked by default across both providers.
14. State corruption is quarantined and reported.
15. Logs are redacted and retained within policy.
16. Windows paths, process handling, cancellation, locking, and review containment pass.
17. Artifact-isolation tests prove there is no cross-plugin runtime dependency.
18. Plugin releases and versions remain independent.
19. Codex license, NOTICE, attribution, and import provenance are intact.
20. Legacy Codex data can be imported explicitly without modifying the source data.

## 24. Approval and implementation boundary

This document defines the approved design. It does not authorize scaffolding or implementation by itself.

After the user reviews and approves this written specification, the next step is a separate detailed implementation plan produced through the writing-plans workflow. Implementation begins only after that plan is reviewed and approved.
