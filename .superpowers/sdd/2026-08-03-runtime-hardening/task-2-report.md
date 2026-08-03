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
