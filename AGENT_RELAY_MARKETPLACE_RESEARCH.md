# Agent Relay Marketplace — Research Report

Date: 2026-07-23  
Status: research complete; architecture not yet approved; no implementation started

This report separates verified facts, design inferences, and recommendations. Repository and CLI facts were re-derived from current sources rather than inherited from earlier comparisons.

## 1. Workspace and repository state

### Verified facts

- `D:\PersonalProjects\agent-relay-marketplace` was empty at inspection time.
- It was not a Git repository.
- It contained no `AGENTS.md`, `CLAUDE.md`, `.claude-plugin`, plugin manifest, source tree, or other project instructions.
- The proposed product distinction is valid: a Claude Code marketplace is a catalog/distribution surface. It does not need to become a runtime, a shared broker, or a third relay plugin.

### Recommendation

Keep this repository catalog-only. It should never expose `/agent-relay:*`, own provider authentication, launch provider jobs, or hold provider job state.

## 2. Reference repositories, commits, and local versions

### Verified repository heads

| Reference | Default branch and inspected commit | License / provenance |
|---|---|---|
| [`freema/cursor-plugin-cc`](https://github.com/freema/cursor-plugin-cc) | `main` at [`740279775ffb0bf1c107127374ee31c4facd0045`](https://github.com/freema/cursor-plugin-cc/commit/740279775ffb0bf1c107127374ee31c4facd0045) | MIT |
| [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) | `main` at [`db52e28f4d9ded852ab3942cea316258ae4ef346`](https://github.com/openai/codex-plugin-cc/commit/db52e28f4d9ded852ab3942cea316258ae4ef346) | Apache-2.0 |
| [`hotaru-ritsuki/codex-relay-plugin`](https://github.com/hotaru-ritsuki/codex-relay-plugin) | `main` at [`9000f8fbfcf846531b2a8bce4756cfe2d2798b52`](https://github.com/hotaru-ritsuki/codex-relay-plugin/commit/9000f8fbfcf846531b2a8bce4756cfe2d2798b52) | Apache-2.0 with upstream NOTICE |

### Verified local canonical checkout

- The requested local Codex source exists at `D:\PersonalProjects\codex-cc-relay-plugin`; the similarly named `D:\PersonalProjects\codex-cc-plugin` does not currently exist.
- The checkout is clean on `main` at `9000f8fbfcf846531b2a8bce4756cfe2d2798b52`.
- `origin` is `hotaru-ritsuki/codex-relay-plugin`.
- `upstream` is `openai/codex-plugin-cc`.
- The repository owner confirmed that the GitHub fork-network linkage was removed. Current GitHub metadata exposes it as a standalone repository with no upstream parent relationship.
- The local Git history still has `db52e28f4d9ded852ab3942cea316258ae4ef346` as the merge base with `upstream/main`, so source ancestry and attribution remain available even though GitHub no longer treats the repository as a fork.
- Its plugin identity is already `cdx-relay`, display name `Codex Relay`, version `1.1.6`.

### Verified local tools

| Tool | Current local version |
|---|---|
| Claude Code | `2.1.215` |
| Codex CLI | `0.145.0` |
| Cursor Agent CLI | `2026.07.20-8cc9c0b` |
| Node.js | `22.23.1` |
| npm | `10.9.8` |

Cursor and Codex authentication were checked only for readiness; account identifiers and secrets are deliberately omitted.

## 3. Current Claude Code plugin and marketplace rules

### Verified facts

- The marketplace catalog is `.claude-plugin/marketplace.json`; each listed plugin has its own `name` and `source`.
- Plugin names must be kebab-case. `displayName` is human-readable and does not affect namespacing.
- Skills/commands are namespaced by the plugin name, so `cdx-relay` and `cursor-relay` naturally produce `/cdx-relay:*` and `/cursor-relay:*`. The marketplace name does not become a command namespace.
- Marketplace entries may point at local directories or external `github`, `url`, `git-subdir`, or `npm` sources.
- Installed plugins are copied into Claude Code’s plugin cache. A plugin cannot depend at runtime on `../shared-utils` outside its installed directory.
- `${CLAUDE_PLUGIN_ROOT}` is versioned and ephemeral. `${CLAUDE_PLUGIN_DATA}` is the supported persistent location and is isolated by installed plugin identity.
- On final uninstall, plugin data is deleted unless the user selects `--keep-data`.
- Version resolution is: plugin manifest version, then marketplace entry version, then source commit SHA. Duplicating the version in both manifest and catalog should be avoided.
- `strict: true` is the default and makes the plugin manifest authoritative. This fits independently versioned plugins whether their source is a monorepo subdirectory or an external repository.
- A `Stop` hook can block continuation and receives `stop_hook_active`; implementations must prevent loops. Blocking review gates are therefore possible, but are not harmless defaults.

Sources: [Claude Code plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [plugin reference](https://code.claude.com/docs/en/plugins-reference), [hooks reference](https://code.claude.com/docs/en/hooks).

### Recommendation

Use two strict, self-contained plugin artifacts. They may share build-time contracts and tests in a monorepo, but each installed artifact must contain all of its runtime files. Keep Stop-time review gates opt-in and provider-scoped; use non-blocking completion reporting by default.

## 4. Repository architecture comparison

Scores are recommendations on a 1–5 scale, with all criteria weighted equally for this decision.

| Criterion | A. One monorepo | B. Thin catalog + two external repos | C. Hybrid |
|---|---:|---:|---:|
| Provider independence | 5 | 5 | 4 |
| Architectural clarity | 5 | 5 | 3 |
| Functional fit | 5 | 5 | 5 |
| Safety isolation | 5 | 5 | 4 |
| Windows maintainability | 5 | 4 | 4 |
| General maintainability | 5 | 4 | 3 |
| Testability | 5 | 4 | 4 |
| Release independence | 4 | 5 | 4 |
| Provenance / upstream sync | 4 | 4 | 4 |
| Licensing clarity | 5 | 5 | 3 |
| User experience | 5 | 5 | 5 |
| **Total / 55** | **53** | **51** | **43** |

### A. One monorepo

The catalog and both self-contained plugins live in this repository, for example under `plugins/cdx-relay` and `plugins/cursor-relay`.

- Strengths: one development surface; easy cross-plugin contract and Windows tests; atomic coordinated changes; shared build-time tooling; no fork-network relationship is being sacrificed.
- Independent manifests, versions, changelogs, release jobs, `${CLAUDE_PLUGIN_DATA}` directories, and packaged artifacts preserve provider independence even though the source is in one Git repository.
- Costs: CI must prevent runtime imports across plugin boundaries; upstream Codex updates need a documented import procedure; per-plugin license and NOTICE boundaries must remain explicit.

### B. Thin catalog plus two external plugin repositories

This repository contains the catalog and compatibility/release checks. `cdx-relay` and `cursor-relay` remain external standalone repositories.

- Strengths: matches Claude Code’s native external-source model and provides the strongest organizational release separation.
- Costs: contract changes need coordinated checks; local development spans repositories.
- The coordination cost can be controlled with a versioned contract fixture and marketplace integration tests, without a shared runtime package.

### C. Hybrid

One plugin lives beside the marketplace while the other remains external.

- Strengths: can incubate one plugin locally while leaving the other external.
- Costs: permanently asymmetric governance, confusing release ownership, and a likely later repository move.
- Useful as a temporary incubation state, not as the intended architecture.

### Recommendation

Choose **A: one monorepo**, now that there is no GitHub fork-network relationship to preserve. Keep the two plugins self-contained and independently versioned. Use build-time shared contracts/test fixtures only, enforce a packaging test that rejects cross-plugin runtime imports, and retain the Codex source ancestry plus Apache NOTICE in its plugin directory. Do not use submodules.

## 5. Cursor CLI versus SDK

| Capability | Cursor Agent CLI | Cursor SDK |
|---|---|---|
| Maturity for this plugin | Current local tool; direct behavior verified | Public beta, actively changing |
| Authentication/billing | Reuses the user’s Cursor CLI login and plan behavior | API-key/token-billed integration surface |
| Local execution | Yes | Yes |
| Cloud execution | No current `--cloud` option appeared in live CLI help | First-class local and cloud agents |
| Streaming | `text`, `json`, `stream-json`, optional partial output | Structured streams/events |
| Resume | `resume` / `--resume` / `--continue` | Durable agents/runs and persisted stores |
| Cancellation | Child-process and CLI-session integration required | SDK run cancellation is the cleaner abstraction |
| Safety | `--mode ask|plan`, sandbox, auto-review, explicit force/yolo flags | Local headless runs bypass prompts by default unless auto-review is configured |
| Windows | Native `.cmd` works in this environment; live help verified | Published Windows runtime support and recent Windows fixes |
| Runtime dependency | Existing CLI | Node 22.13+ for current TypeScript package |
| Model discovery | Live `models` command | SDK model options; still must tolerate catalog drift |

Verified current CLI behavior differs from the older reference plugin: text is the current default output, `--output-format stream-json` is explicit, `--mode ask|plan` and sandbox controls exist, and the old reference’s `--cloud` flag is absent from live help.

Composer 2.5 and Composer 2.5 Fast are current distinct model choices. The plugin should explicitly request Standard when configured as the safe default, while validating the live model catalog instead of hard-coding a permanent alias list. Sources: [Composer 2.5](https://cursor.com/composer), [Cursor SDK release](https://cursor.com/changelog/sdk-release), [June 2026 SDK update](https://cursor.com/changelog/sdk-updates-jun-2026), [Cursor SDK cookbook](https://github.com/cursor/cookbook).

### Recommendation

Use the **Cursor CLI as the explicit v1 default transport**. It preserves the user’s existing login and avoids silently moving them to API-key billing. Design a transport interface so the SDK can be added later as an explicit opt-in for durable cloud/local SDK runs. Never auto-fallback between transports after a job may have started or modified files.

## 6. Codex transport comparison

| Capability | `codex exec` | Codex SDK | `codex app-server` |
|---|---|---|---|
| Current status | Stable CLI automation surface | Official automation integration | Experimental deep-integration surface |
| One-shot work | Excellent | Excellent | More machinery than needed |
| Persistent sessions/resume | JSONL and resume commands | Thread objects and resume | Native thread/start, thread/resume |
| Streaming | JSONL | SDK stream abstraction | Rich protocol notifications |
| Structured output | Output schema | SDK result types | Generated protocol schemas/events |
| Interrupt/steer | Process/session handling | SDK-dependent abstraction | Native turn/interrupt and turn/steer |
| Approvals and interactive events | Limited for headless delegation | Higher-level API | Richest control surface |
| Compatibility risk | Lowest | Moderate | Highest; protocol is experimental |

Sources: [Codex CLI reference](https://developers.openai.com/codex/cli/reference), [Codex SDK](https://developers.openai.com/codex/sdk), [Codex app-server](https://developers.openai.com/codex/app-server), [Codex Windows sandbox](https://developers.openai.com/codex/windows).

### Verified fork implementation

The current `cdx-relay` fork already has a persistent app-server broker, generated protocol types, thread/turn IDs, native `turn/interrupt`, session-scoped jobs, Windows process-tree termination, setup/doctor behavior, result/status rendering, and an opt-in Stop review gate.

Its state layer is useful but should be hardened in the new design contract: some state writes are direct whole-file writes rather than locked atomic replacements, so concurrent writers remain a design risk.

### Recommendation

Preserve the current **app-server broker behind a provider transport adapter** for `cdx-relay`; that is where its session, interrupt, review, and streaming value lives. Treat the protocol as version-sensitive: require a tested Codex CLI range, regenerate schemas per supported release, detect capabilities at startup, and fail closed on mismatches.

Use `codex exec` only as an explicit simpler mode for isolated one-shot work. Do not automatically retry a potentially mutating app-server request via another transport. Evaluate an SDK migration later, after confirming it covers exact interrupt, approval, and review semantics without losing functionality.

## 7. Windows-first findings

### Verified facts

- Both provider CLIs run natively in this inspected Windows environment.
- The Cursor reference plugin resolves executables with POSIX `which`, uses POSIX-oriented detached process/signaling assumptions, and hard-codes behavior that does not match current live CLI help.
- The current Codex Relay fork already has a Windows process-tree path using `taskkill /PID … /T /F`.
- Codex documents a native Windows sandbox and distinguishes sandbox policy from approval policy.
- Cursor’s June SDK update explicitly includes Windows packaging/path fixes.

### Recommendation

Implement a platform process adapter. On Windows, prefer provider-native cancellation first, then verified process-tree termination. Persist PID plus creation time and a per-launch nonce to reduce PID-reuse mistakes. Use argument-array spawning, canonical absolute paths, Windows-safe atomic replacement with bounded retry, and tests with paths containing spaces and non-ASCII characters.

Native Cursor CLI behavior should be classified as empirically supported by the tested version until its consolidated documentation provides an equally precise Windows support statement.

## 8. Security and safety findings

### Verified risks in the Cursor reference

- `--force` is the default and `--trust` is always supplied.
- Its review flow is prompt-constrained, then checks for changed files after the run; that detects writes but does not prevent them.
- It stores full event streams that may contain prompts, paths, tool arguments, and sensitive output.
- It relies on stale model aliases and a now-absent `--cloud` CLI option.
- PID-only cancellation has an admitted PID-reuse risk.

### Recommendation

- Never default to `--force`, `--yolo`, `--trust`, bypass permissions, full access, or disabled sandboxing.
- A read-only review must combine provider read-only mode, OS/provider sandboxing, allowed-root checks, and a post-flight change check. Prompt text alone is not a security boundary.
- Use native provider auth. Do not copy credentials into plugin state. A future Cursor SDK API key must come from the environment or native credential facility and must never be logged.
- Store bounded/redacted operational logs by default. Full raw streams require explicit diagnostic opt-in and a retention limit.
- Fail closed when safety capability detection, model validation, workspace resolution, or transport version checks fail.
- Make network and MCP behavior explicit in each job’s safety envelope.

## 9. Licensing and provenance

### Verified facts

- `freema/cursor-plugin-cc` is MIT-licensed. Reuse requires retaining its copyright/license notice.
- `openai/codex-plugin-cc` and the current Codex Relay codebase are Apache-2.0, with NOTICE obligations that must remain intact.
- Codex Relay is now a standalone GitHub repository. Its local history still descends from the inspected OpenAI upstream commit, preserving commit-level attribution without a GitHub fork-network relationship.
- The current Cursor SDK package refers to its bundled license file rather than presenting a simple MIT/Apache package label.

### Recommendation

Import `cdx-relay` into the monorepo with its Apache-2.0 license, NOTICE, meaningful history, and modified-file provenance intact. Build `cursor-relay` as a new, independently licensed implementation, borrowing only carefully selected MIT-licensed ideas with attribution if code is copied. Review the exact Cursor SDK redistribution terms before adding it as a dependency. Give each plugin directory an explicit license boundary and choose a root repository license before publishing.

## 10. Strategy comparison: copy, fork, or clean implementation

| Strategy | Assessment |
|---|---|
| Import Codex Relay and build Cursor Relay in one monorepo | Best development and test surface now that no fork-network relationship exists; requires strict artifact boundaries |
| Keep two external standalone repositories | Strongest organizational release separation, but adds cross-repository coordination without preserving any additional GitHub lineage |
| Fork the Cursor reference | Poor fit because substantial CLI, safety, state, and Windows mechanics need replacement |

### Recommendation

Import Codex Relay while preserving its license, NOTICE, and meaningful history. Create Cursor Relay cleanly in the same monorepo, using the MIT reference as a documented research source rather than as an architecture to clone wholesale.

## 11. Recommended system architecture

```text
agent-relay-marketplace
├── .claude-plugin/marketplace.json
├── contracts/                 # specification and test fixtures only
├── tooling/                   # build/release checks; no installed runtime
└── plugins/
    ├── cdx-relay/
    │   ├── independent manifest/version/license/NOTICE
    │   ├── /cdx-relay:* skills/commands
    │   ├── Codex transport and state
    │   └── self-contained packaged artifact
    └── cursor-relay/
        ├── independent manifest/version/license
        ├── /cursor-relay:* skills/commands
        ├── Cursor transport and state
        └── self-contained packaged artifact
```

The shared contract is a specification and test fixture, not a shared runtime service. Each installed plugin bundles everything it needs and is sourced from its own monorepo subdirectory. A failure, uninstall, update, authentication change, or state migration in one plugin does not touch the other. Independent manifest versions allow one plugin to release without bumping the other.

## 12. Proposed v1 command surfaces

This is a recommendation for design review, not an approved interface.

### Common verbs under separate provider namespaces

| Verb | Purpose |
|---|---|
| `delegate` | Start work; `--wait` or `--background` selects foreground/background behavior |
| `status [job]` | Show one job or recent jobs, with provider-native phase detail |
| `result <job>` | Return the normalized result plus provider-native details |
| `cancel <job>` | Request provider-native cancellation, then safely terminate if necessary |
| `resume <job>` | Resume only when the provider session identity is valid |
| `doctor` | Validate provider binary, version, auth, model, sandbox, state, and Windows behavior |
| `setup` | Configure only that provider’s defaults and optional hooks |

### Provider-specific verbs

- `cdx-relay:review` and `cdx-relay:adversarial-review` can remain first-class because Codex has a dedicated review surface and the current fork implements them.
- `cdx-relay:rescue` / `transfer` compatibility should be decided during detailed design rather than silently removed.
- `cursor-relay:review` should ship only when current ask/plan mode plus sandboxing passes a real no-write gate. It must not reproduce the reference’s prompt-only control.

Separate `delegate-async`, `sessions`, and `from-plan` commands are not necessary in v1 if `delegate --background`, `status --all`, and normal prompt/plan input cover the same jobs with less surface area.

## 13. Proposed transport choices

| Plugin | v1 default | Explicit alternatives | Forbidden fallback |
|---|---|---|---|
| `cdx-relay` | Existing app-server broker/adapter | One-shot `codex exec` where explicitly selected | Retrying a possibly mutating request through another transport |
| `cursor-relay` | Current Cursor Agent CLI | Future opt-in SDK transport after license/billing/safety approval | Silently switching from user-login CLI billing to SDK API-key billing |

Transport, provider version, model, safety mode, and provider session ID must be stored in every job record and result.

## 14. Proposed state and job model

Each plugin uses its own `${CLAUDE_PLUGIN_DATA}` subtree and owns its schema migrations.

Normalized lifecycle:

`queued → starting → running ↔ waiting → completed | failed | cancelled | timed_out | interrupted | partial`

Provider-native phases and raw event names remain available alongside the normalized lifecycle; normalization must not erase useful distinctions.

Minimum result envelope:

- schema version, provider, plugin version, job ID, parent Claude session ID
- canonical workspace identity
- transport, provider version, provider session/thread/run identifiers
- model and safety policy
- timestamps and normalized status
- final summary/output and bounded event reference
- changed files, artifacts, verification evidence
- cancellation/timeout detail
- structured error with retry-safety classification

State writes should use per-workspace locking, atomic replacement, recovery from interrupted writes, a schema migration journal, and bounded retention. A cancellation record must distinguish “request accepted,” “provider confirmed stopped,” and “local process tree terminated.”

## 15. Rejected approaches

- A marketplace-level runtime, broker, authentication store, state store, or `/agent-relay:*` command surface.
- Runtime imports across plugin directories or a required shared package installed outside each plugin.
- Submodules for routine marketplace composition.
- Automatic cross-transport retry after a job may have started.
- Default Cursor `--force`, `--trust`, `--yolo`, disabled sandbox, or Codex full-access/bypass modes.
- Prompt-only read-only review.
- POSIX-only executable discovery or cancellation.
- Permanent hard-coded model lists.
- Merging provider-specific raw statuses into a lowest-common-denominator state that makes debugging impossible.
- Shipping a blocking Stop gate by default.

## 16. Approved design decisions

The user approved these decisions one at a time:

1. Use the monorepo architecture as the design baseline.
2. Use only the authenticated Cursor CLI in v1; defer the SDK and separate API-key/token billing.
3. Preserve all existing `/cdx-relay:*` commands in v1 while adding the common command vocabulary.
4. Keep the Codex Stop review gate optional and disabled by default; ship Cursor v1 without a blocking Stop gate.
5. Use Apache-2.0 for the monorepo root and new Cursor Relay plugin, retaining required MIT attribution for any reused material.

The approved written design is recorded in `docs/superpowers/specs/2026-07-23-agent-relay-marketplace-design.md`. No implementation plan or plugin scaffold is created until the written specification passes the user-review gate.
