# Task 2 Report: App-server transport death and short RPC deadlines

## Status

DONE

Base: `c359769` (`test: cover authoritative runner behavior`)

Commit subject: `fix: make app server requests terminal`

## Scope delivered

- Extended `AppServerClient.request(method, params, { timeoutMs })` with a 30-second method deadline by default and focused-test overrides.
- Added `deadlineForMethod(method)` as the default deadline policy seam.
- Made direct-process `error`, `exit`, `close`, stdin write errors, broker socket `error`, and broker socket `close` converge on one idempotent terminal path.
- Terminal settlement now marks the client closed, clears and rejects every pending request, clears each request deadline, rejects every registered long-turn waiter, clears the waiter set, and resolves the logical exit promise once.
- Direct stdin and broker socket writes now install both stream error listeners and write callbacks. Low-level `EPIPE`/Windows `EOF` details remain in the error cause instead of escaping as an uncaught exception or public rejection message.
- `captureTurn` registers a terminal listener only after admission, removes it on every exit path, and rejects completion if the transport dies after admission.
- A whole-turn deadline is applied only when the caller supplies `captureTurn(..., { timeoutMs })`; ordinary long turns have no blanket completion timeout.
- Direct-process close still waits for the actual child close and retains bounded process-tree termination after a logical transport failure.
- Broker lifecycle/ownership logic was not changed.

## RED evidence

Required command against the old implementation plus the new real-process fixtures:

`node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/runtime.test.mjs`

Observed Task 2 failures:

- Peer exit rejected the two requests but left `client.closed === false`.
- A live silent `account/read` outlived its injected 30 ms deadline and hit the 250 ms negative-control guard.
- A silent `turn/start` admission outlived its injected 30 ms deadline and hit the 250 ms guard.
- `captureTurn` was not exposed for direct real-transport completion/terminal testing.
- The write-pressure probe timed out because the old client neither settled the write nor bounded the request.

The first RED pressure probe used the shared supervisor's external timeout and consequently poisoned later tests in that RED-only run. Before GREEN verification, the probe was corrected with its own 1.5-second watchdog so failure remains isolated and test output remains pristine.

Additional mutation RED for caller-controlled whole-turn completion:

`node --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern="caller can explicitly bound whole-turn completion" plugins/cdx-relay/tests/runtime.test.mjs`

With the new capture deadline block deliberately removed, the test failed because the 30 ms caller deadline was ignored and the 250 ms negative-control guard won. Restoring the implementation made the case pass.

## GREEN evidence

New focused cases:

`node --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern="direct app-server peer exit|live but silent app-server|turn start admission|turn completion can outlive|caller can explicitly bound|transport death after turn admission|direct stdin write pressure" plugins/cdx-relay/tests/runtime.test.mjs`

Result: 7 tests passed, 0 failed.

Full runtime gate:

`node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/runtime.test.mjs`

Result: 85 tests passed, 0 failed in 237.3 seconds.

Final package gate after the last production change:

`npm --prefix plugins/cdx-relay test`

Result: 324 tests total; 319 passed, 5 skipped, 0 failed in 375.5 seconds. The package gate includes the app-server TypeScript build test and all 85 runtime cases.

## Self-review

- Request timers are owned by pending entries and cleared through `takePending` on success, JSON-RPC error, deadline expiry, transport failure, write failure, and explicit close.
- The terminal path snapshots request IDs before settlement, so rejecting callbacks cannot invalidate iteration or leave map entries behind.
- Terminal listeners are invoked independently, then cleared; a faulty listener cannot prevent later waiters from settling.
- The 30 ms admission test and 400 ms delayed completion test prove the admission timer is cleared and is not reused as a turn-completion timer.
- The explicit whole-turn timeout uses a separate timer from the existing inferred-completion timer; both are cleared on success, failure, timeout, and `finally` cleanup.
- The 64 MiB real child-process pressure probe closes peer stdin, exits during the pressured write, installs an `uncaughtException` sentinel, and asserts no `EPIPE`/`EOF` text escapes.
- Only the four Task 2 files plus this report changed. No broker lifecycle implementation was modified.

## Concerns

None.

## Fix Round 1

### Findings addressed

1. Protocol input is now bounded at 8 MiB per JSONL message for both broker input and direct app-server stdout. Direct stdout no longer uses `readline`, so an unterminated line is checked incrementally rather than accumulated inside an uncapped library buffer. Oversized input clears the retained line and terminates through the existing idempotent terminal path.
2. Retained direct-process stderr is capped at 64 KiB. The most recent diagnostic tail is preserved, exit errors identify truncation, and malformed-protocol previews are capped separately at 4 KiB.
3. `CodexAppServerClient.connect` now closes/terminalizes the newly created direct child or broker socket when `initialize` fails for any reason. A focused `initializeTimeoutMs` option drives real timeout cleanup tests without changing the 30-second production default.
4. The deferred Windows scheduler assertion was naturally removed while the deadline tests were amended; deadline identity and the existing generous watchdog remain authoritative.

No broker lifecycle implementation was changed.

### RED evidence

Command:

`node --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern="oversized unterminated|stderr diagnostics stay bounded|cleanup terminates the spawned|cleanup closes the socket" plugins/cdx-relay/tests/runtime.test.mjs`

After correcting a test-fixture newline escape, all seven controls failed for the intended missing behavior:

- Oversized unterminated broker input remained buffered until the 1.5-second guard.
- Oversized direct stdout reached the uncapped `readline` path and failed only when the peer later exited and the retained 9 MiB line was parsed.
- A 256 KiB stderr payload appeared unbounded in the initialize failure.
- Silent direct and broker initialization ignored the injected 30 ms deadline.
- Direct and broker JSON-RPC initialize errors rejected but left the child/socket alive.

### GREEN evidence

Focused Fix Round 1 controls: 7 passed, 0 failed in 1.9 seconds.

Full amended runtime command:

`node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/runtime.test.mjs`

Result: 92 passed, 0 failed in 250.5 seconds.

Package command:

`npm --prefix plugins/cdx-relay test`

Result: 331 total; 326 passed, 5 skipped, 0 failed in 389.8 seconds. This includes the app-server TypeScript build contract.

### Fix-round self-review

- The JSONL cap is checked before appending each decoded segment, including unterminated input; both broker and direct streams share this path.
- Limit-plus-one input terminalizes and releases the partial line.
- EOF preserves prior direct behavior by parsing a final bounded non-newline-terminated message.
- Stderr retention never exceeds 64 KiB and preserves the tail marker emitted after the hostile payload.
- Parse-error protocol data stores only a bounded preview instead of retaining an otherwise-valid 8 MiB line.
- Direct cleanup awaits actual process close; broker cleanup destroys and awaits socket close. The original initialize error is rethrown after best-effort cleanup.
- Test cleanup independently terminates hostile fixture processes/sockets, so RED failures do not contaminate later tests.

### Fix-round concerns

None.

## Fix Round 2

### Finding addressed

Direct-process stderr now terminalizes the app-server client as soon as retained stderr would exceed the 64 KiB cap. The overflow error includes the bounded diagnostic tail and uses the same idempotent terminal path as other transport failures, so pending requests reject exactly once and normal child-process cleanup runs even while the peer remains alive.

### RED evidence

Command:

`node --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern="direct stderr overflow terminally rejects initialize and cleans up" plugins/cdx-relay/tests/runtime.test.mjs`

The hostile fixture emitted oversized stderr and deliberately stayed alive. Before the production change, the 1.5-second negative-control guard failed with `stderr overflow did not terminalize the client`.

### GREEN evidence

The same focused command passed 1/1. It asserts prompt rejection from the client itself, the 65,536-character cap and truncation diagnostic, preservation of the diagnostic marker, a bounded error message, and observed termination of the still-live fixture process.

Syntax checks passed for the production module, fixture, and runtime test.

Full runtime command:

`node --test --test-concurrency=1 --test-timeout=600000 plugins/cdx-relay/tests/runtime.test.mjs`

Result: 92 passed, 0 failed in 250.2 seconds.

Package command:

`npm --prefix plugins/cdx-relay test`

Result: 331 total; 326 passed, 5 skipped, 0 failed in 392.5 seconds. This includes the app-server TypeScript build contract.

### Fix-round self-review

- Exactly the configured cap remains accepted; the first character beyond it terminalizes.
- The retained diagnostic tail never exceeds 64 KiB, and the overflow error adds only a bounded prefix/marker.
- `handleExit` closes before settling pending work; later stderr chunks are ignored and cannot emit a second terminal event.
- The connect failure path performs its existing awaited child-process cleanup, independently confirmed by polling the fixture PID.
- No broker lifecycle implementation changed.

### Fix-round concerns

None.
