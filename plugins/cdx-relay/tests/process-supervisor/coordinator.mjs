import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { SupervisorInfrastructureError } from "./errors.mjs";
import { assertBoundedFrame } from "./protocol.mjs";
import { assertCleanupProven, createTerminalResult } from "./result.mjs";

export const defaultBackendFactories = [];

function infrastructureError(error, fallbackCode = "SUPERVISOR_FAILURE") {
  if (error instanceof SupervisorInfrastructureError) return error;
  return new SupervisorInfrastructureError(
    fallbackCode,
    error?.message ?? String(error),
    { cause: error }
  );
}

export function createProcessSupervisor({
  mode = "auto",
  minimumGuarantee = "cooperative",
  platform = process.platform,
  backendFactories = defaultBackendFactories,
  discoverRecordedProcesses = async () => [],
  syncBridge = (runAsync, spec) => runAsync(spec)
} = {}) {
  const epoch = randomUUID();
  const leases = new Map();
  let backend;
  let backendCapabilities;
  let cleanupInFlight;
  let shutdownInFlight;
  let shutdownStarted = false;
  let latchedFailure;

  const latch = (error, fallbackCode) => {
    const normalized = infrastructureError(error, fallbackCode);
    latchedFailure ??= normalized;
    return normalized;
  };

  const capabilities = (async () => {
    for (const factory of backendFactories) {
      const candidate = await factory({ platform, mode, minimumGuarantee });
      if (!candidate) continue;
      const probe = await candidate.probe();
      if (!probe?.available) continue;
      const candidateCapabilities = probe.capabilities;
      const strictEnough = mode !== "host-strict" &&
          minimumGuarantee !== "host-strict" ||
        candidateCapabilities?.mode === "host-strict";
      if (!strictEnough) continue;
      backend = candidate;
      backendCapabilities = candidateCapabilities;
      return candidateCapabilities;
    }
    throw latch(new SupervisorInfrastructureError(
      "CAPABILITY_UNAVAILABLE",
      `No ${minimumGuarantee} process supervisor backend is available for ${platform}.`
    ));
  })();

  function assertCanLaunch() {
    if (shutdownStarted) {
      throw new SupervisorInfrastructureError(
        "SUPERVISOR_SHUTDOWN",
        "The process supervisor has shut down."
      );
    }
    if (latchedFailure) throw latchedFailure;
  }

  async function cleanupLease(lease) {
    if (!lease.cleanupPromise) {
      lease.cleanupPromise = (async () => {
        try {
          const cleanup = typeof lease.launch.cleanup === "function"
            ? await lease.launch.cleanup()
            : lease.launch.cleanup;
          lease.cleanup = cleanup;
          return cleanup;
        } catch (error) {
          throw latch(error, "CLEANUP_FAILED");
        }
      })();
    }
    return lease.cleanupPromise;
  }

  function createFakeLaunch({ root, cleanup, pid = 1 } = {}) {
    return {
      pid,
      root: new Promise((resolve) => setImmediate(() => resolve(root))),
      cleanup,
      kill() {
        return true;
      }
    };
  }

  async function launch(spec) {
    assertCanLaunch();
    await capabilities;
    assertCanLaunch();
    const runId = randomUUID();
    const nonce = randomUUID();
    let launched;
    try {
      launched = await backend.launch(
        { ...spec, epoch, runId, nonce },
        {
          epoch,
          runId,
          nonce,
          assertFrame: assertBoundedFrame,
          createFakeLaunch
        }
      );
    } catch (error) {
      throw latch(error, "LAUNCH_FAILED");
    }
    if (!launched || !launched.root) {
      throw latch(new SupervisorInfrastructureError(
        "INVALID_BACKEND_LAUNCH",
        "The backend did not return a root completion."
      ));
    }
    const lease = {
      epoch,
      runId,
      nonce,
      launch: launched,
      requestedSignal: null
    };
    leases.set(runId, lease);
    return lease;
  }

  async function settleLease(lease, completedRoot) {
    let root;
    try {
      root = completedRoot ?? await lease.launch.root;
    } catch (error) {
      throw latch(error, "TRANSPORT_FAILED");
    }
    const cleanup = await cleanupLease(lease);
    const result = createTerminalResult({
      root,
      backend: backendCapabilities,
      cleanup,
      requestedSignal: lease.requestedSignal,
      terminationCause: lease.requestedSignal ? "requested-signal" : "root-exit"
    });
    try {
      return assertCleanupProven(result, minimumGuarantee);
    } catch (error) {
      throw latch(error);
    } finally {
      leases.delete(lease.runId);
    }
  }

  async function runAsync(spec) {
    const lease = await launch(spec);
    return settleLease(lease);
  }

  function run(spec) {
    assertCanLaunch();
    return syncBridge(runAsync, spec);
  }

  async function spawnTracked(spec) {
    const lease = await launch(spec);
    const exposedChild = lease.launch.child;
    const child = exposedChild ?? new EventEmitter();
    child.pid = lease.launch.pid;
    child.stdout ??= lease.launch.stdout ?? null;
    child.stderr ??= lease.launch.stderr ?? null;
    child.exitCode ??= null;
    child.signalCode ??= null;
    child.ref = () => {
      lease.launch.ref?.();
      return child;
    };
    child.unref = () => {
      lease.launch.unref?.();
      return child;
    };
    let killRequested = false;
    const launchKill = exposedChild
      ? exposedChild.kill.bind(exposedChild)
      : lease.launch.kill?.bind(lease.launch);
    child.kill = (signal = "SIGTERM") => {
      if (killRequested || child.exitCode !== null || child.signalCode !== null) {
        return false;
      }
      killRequested = true;
      lease.requestedSignal = signal;
      return launchKill?.(signal) !== false;
    };

    let resolveCompletion;
    let rejectCompletion;
    child.completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void (async () => {
      try {
        const root = await lease.launch.root;
        child.exitCode = root.status ?? null;
        child.signalCode = root.signal ?? null;
        if (!exposedChild) child.emit("exit", child.exitCode, child.signalCode);
        const result = await settleLease(lease, root);
        resolveCompletion(result);
        if (!exposedChild) {
          queueMicrotask(() => child.emit(
            "close",
            child.exitCode,
            child.signalCode
          ));
        }
      } catch (error) {
        rejectCompletion(error);
        if (!exposedChild) queueMicrotask(() => child.emit("close", null, null));
      }
    })();
    return child;
  }

  function cleanupAll() {
    if (cleanupInFlight) return cleanupInFlight;
    cleanupInFlight = (async () => {
      const failures = [];
      let recorded = [];
      try {
        recorded = await discoverRecordedProcesses();
      } catch (error) {
        failures.push(latch(error, "DISCOVERY_FAILED"));
      }
      for (const processRecord of recorded) {
        const matching = leases.get(processRecord.runId);
        if (!matching ||
            matching.epoch !== processRecord.epoch ||
            matching.nonce !== processRecord.nonce) {
          failures.push(latch(new SupervisorInfrastructureError(
            "UNREGISTERED_RECORDED_PROCESS",
            "Discovered process state has no live matching lease.",
            { result: processRecord }
          )));
        }
      }
      await Promise.all([...leases.values()].map(async (lease) => {
        try {
          await cleanupLease(lease);
        } catch (error) {
          failures.push(error);
        }
      }));
      try {
        await capabilities;
        await backend.cleanupAll?.();
      } catch (error) {
        failures.push(latch(error, "CLEANUP_FAILED"));
      }
      if (failures.length > 0 || latchedFailure) {
        throw latchedFailure ?? failures[0];
      }
      return { cleaned: true };
    })().finally(() => {
      cleanupInFlight = undefined;
    });
    return cleanupInFlight;
  }

  function shutdown() {
    if (shutdownInFlight) return shutdownInFlight;
    shutdownStarted = true;
    shutdownInFlight = (async () => {
      let cleanupError;
      try {
        await cleanupAll();
      } catch (error) {
        cleanupError = error;
      }
      try {
        await capabilities;
        await backend.shutdown();
      } catch (error) {
        latch(error, "SHUTDOWN_FAILED");
      }
      if (cleanupError || latchedFailure) throw latchedFailure ?? cleanupError;
      return { stopped: true };
    })();
    return shutdownInFlight;
  }

  function assertHealthy() {
    if (latchedFailure) throw latchedFailure;
  }

  return {
    capabilities,
    run,
    runAsync,
    spawnTracked,
    cleanupAll,
    shutdown,
    assertHealthy
  };
}
