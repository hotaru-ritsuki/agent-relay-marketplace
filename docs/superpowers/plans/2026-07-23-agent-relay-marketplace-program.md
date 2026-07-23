# Agent Relay Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and release a catalog-only Claude Code marketplace containing independent Codex Relay and Cursor Relay plugins.

**Architecture:** Work is divided into four ordered plans. The contract/tooling foundation is implemented first; Codex Relay and Cursor Relay can then be implemented independently; marketplace integration and release gates are last. Installed plugins share specifications and fixtures but no runtime imports or state.

**Tech Stack:** Node.js ESM, Node built-in test runner, JSON Schema with Ajv at development time, Claude Code plugin manifests, Codex app-server, Cursor Agent CLI, GitHub Actions, PowerShell-compatible tooling.

## Global Constraints

- Marketplace identity: `agent-relay-marketplace`.
- Plugin identities: `cdx-relay` and `cursor-relay`; no `/agent-relay:*` command.
- Runtime floor: Node.js 20; Node.js 22 is required in the release matrix.
- Root and Cursor Relay license: Apache-2.0.
- Codex Relay retains Apache-2.0, NOTICE, source attribution, and relevant Git history.
- Cursor Relay v1 uses only the authenticated local Cursor Agent CLI.
- Cursor SDK, cloud agents, API-key authentication, and SDK billing are excluded.
- Codex Relay preserves every v1.1.6 command.
- Codex Stop review gate is optional and disabled by default.
- Cursor Relay has no blocking Stop hook.
- Plugins are independently installable, versioned, configured, stateful, releasable, and uninstallable.
- Shipped plugin code cannot import from the repository root or sibling plugin.
- Normal execution cannot default to force, yolo, trust, permission bypass, disabled sandboxing, or automatic MCP approval.
- Native Windows tests are mandatory and release-blocking.
- Use TDD for every behavior change and commit after every task.

---

## Plan order

1. [Foundation and contracts](2026-07-23-agent-relay-marketplace-01-foundation.md)
2. [Codex Relay import and adaptation](2026-07-23-agent-relay-marketplace-02-codex-relay.md)
3. [Cursor Relay implementation](2026-07-23-agent-relay-marketplace-03-cursor-relay.md)
4. [Marketplace integration and release](2026-07-23-agent-relay-marketplace-04-integration-release.md)

Plans 2 and 3 both depend on Plan 1. They may be executed in either order or in isolated worktrees after the repository exists. Plan 4 requires Plans 2 and 3 to be complete.

## Specification coverage

| Design sections | Implemented by |
|---|---|
| 1–4: summary, goals, exclusions, decisions | Program constraints and all completion gates |
| 5–6: repository and isolation | Foundation Tasks 1–4; Integration Tasks 1–2 |
| 7–8: components and commands | Codex Task 5; Cursor Tasks 1 and 5 |
| 9–10: transports, auth, trust, safety | Codex Tasks 4–5; Cursor Tasks 2, 4, and 6 |
| 11–12: execution and concurrency | Codex Tasks 3–5; Cursor Tasks 3–5; Integration Task 2 |
| 13–16: persistence, results, cancellation, errors | Codex Tasks 3–4; Cursor Tasks 3–5 |
| 17–18: Windows and hooks | Codex Tasks 2 and 4; Cursor Tasks 2, 5, and 7; Integration Task 4 |
| 19: versioning and release | Codex Task 6; Cursor Task 7; Integration Tasks 3–5 |
| 20: legacy Codex migration | Codex Task 6; Integration Task 5 |
| 21: licensing and provenance | Foundation Task 1; Codex Tasks 1 and 6; Cursor Tasks 1 and 7 |
| 22–23: testing and acceptance | Every task’s red/green cycle; Integration program completion gate |
| 24: approval boundary | This plan suite; execution requires the user’s separate plan approval |

## Cross-plan interface registry

These names and signatures are authoritative across the suite:

| Interface | Signature |
|---|---|
| Contract sync | `syncContracts({ rootDir: string, pluginDirs: string[] }): void` |
| Isolation check | `checkPluginIsolation(pluginDir: string): Array<{file: string, message: string}>` |
| Safety check | `checkForbiddenFlags(pluginDir: string): Array<{file: string, message: string}>` |
| Atomic write | `writeAtomicJson(file: string, value: unknown): void` |
| Job store factory | `createJobStore({ pluginDataDir: string, workspaceRoot: string, clock?: () => Date }): JobStore` |
| Job store | `{create, transition, appendEvent, complete, read, list, prune}` |
| Relay error | `new RelayError(code: string, message: string, options?): RelayError` |
| Lease acquire | `acquireWorkspaceLease({ provider, workspaceRoot, jobId, processIdentity, expiresAt, allowConcurrentWrites }): WorkspaceLease` |
| Lease release | `releaseWorkspaceLease({ workspaceRoot, provider, jobId, nonce }): void` |
| Snapshot | `captureWorkspaceSnapshot(workspaceRoot: string): WorkspaceSnapshot` |
| Snapshot delta | `diffWorkspaceSnapshots(before, after): WorkspaceDelta` |
| Result mapping | `toResultEnvelope(input): ResultEnvelope` |
| Plugin transport | `{detect, start, stream, resume, interrupt, dispose}` |
| Artifact package | `packagePlugin({ pluginDir: string, outputDir: string }): void` |
| Artifact hash | `hashArtifact(directory: string): string` |

## Program checkpoints

- [ ] **Checkpoint 1:** Foundation schemas and tooling pass on Windows with no plugin runtime present.
- [ ] **Checkpoint 2:** Imported Codex Relay 1.2.0 passes compatibility, state, migration, and Windows gates in isolation.
- [ ] **Checkpoint 3:** Cursor Relay 1.0.0 passes CLI, safety, state, cancellation, review, and Windows gates in isolation.
- [ ] **Checkpoint 4:** Marketplace validation, isolated packaging, cross-provider leases, release metadata, and installation smoke tests pass.
- [ ] **Checkpoint 5:** Run the full verification matrix and review the resulting diff before tagging or publishing.

## Execution rule

Do not begin a later checkpoint when an earlier checkpoint has failures. Do not tag, publish, or install the marketplace globally as part of implementation unless the user separately authorizes that external change.

## Program completion gate

The program is complete only when Checkpoints 1–5 are checked, every child plan’s completion command exits 0, `git diff --check` has no output, and `git status --short` is empty.
