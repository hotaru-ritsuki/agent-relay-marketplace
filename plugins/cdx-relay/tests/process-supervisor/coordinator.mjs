import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import process from "node:process";

import { SupervisorInfrastructureError } from "./errors.mjs";
import {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  assertBoundedFrame,
  validateCleanup,
  validateLaunch,
  validateProof,
  validateRoot,
  validateStop
} from "./protocol.mjs";
import {
  assertCleanupProven,
  createChildTerminalizer,
  createTerminalResult
} from "./result.mjs";
import { runSynchronous } from "./worker.mjs";
import { decodeSupervisorToken } from "./backends/posix-process-group.mjs";

export const defaultBackendFactories = [];
export const SUPERVISOR_TOKEN_ENV = "CDX_RELAY_SUPERVISOR_TOKEN";

const controlledRegistrations = new Set();

export function inheritSupervisorEnvironment(env = process.env) {
  return { ...env };
}

async function openRegistrationSocket(token, hello, {
  handshakeMs = 5000
} = {}) {
  if (!token.endpoint.startsWith("unix:")) {
    throw new SupervisorInfrastructureError(
      "PROTOCOL_INVALID_ENDPOINT",
      "Controlled POSIX descendants require a Unix registration socket."
    );
  }
  const socket = net.createConnection({
    path: token.endpoint.slice("unix:".length)
  });
  socket.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    let pending = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SupervisorInfrastructureError(
        "PROTOCOL_HANDSHAKE_TIMEOUT",
        "Controlled descendant release deadline expired."
      ));
    }, handshakeMs);
    const onError = (error) => {
      clearTimeout(timer);
      reject(new SupervisorInfrastructureError(
        "PROTOCOL_LOST",
        "Controlled descendant registration failed.",
        { cause: error }
      ));
    };
    socket.once("error", onError);
    socket.on("data", (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) {
        clearTimeout(timer);
        socket.destroy();
        reject(new SupervisorInfrastructureError(
          "PROTOCOL_FRAME_TOO_LARGE",
          `Release frame exceeds ${MAX_FRAME_BYTES} bytes.`
        ));
        return;
      }
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      let release;
      try {
        release = JSON.parse(pending.slice(0, newline));
      } catch (error) {
        reject(new SupervisorInfrastructureError(
          "PROTOCOL_INVALID_MESSAGE",
          "Controlled descendant received an invalid release frame.",
          { cause: error }
        ));
        return;
      }
      if (release.type !== "release" || release.version !== PROTOCOL_VERSION) {
        reject(new SupervisorInfrastructureError(
          "PROTOCOL_INVALID_MESSAGE",
          "Controlled descendant received an invalid release frame."
        ));
        return;
      }
      socket.off("error", onError);
      clearTimeout(timer);
      socket.unref();
      resolve();
    });
    socket.write(`${JSON.stringify(hello)}\n`);
  });
  return socket;
}

export async function registerControlledDescendant({
  env = process.env,
  pid = process.pid,
  parentPid = process.ppid,
  openRegistration = openRegistrationSocket,
  handshakeMs = 5000
} = {}) {
  const encoded = env?.[SUPERVISOR_TOKEN_ENV];
  if (!encoded) return { registered: false };
  const token = decodeSupervisorToken(encoded);
  const hello = {
    type: "hello",
    version: PROTOCOL_VERSION,
    epoch: token.epoch,
    runId: token.runId,
    nonce: token.nonce,
    backend: "posix-cooperative",
    pid,
    parentPid
  };
  const connection = await openRegistration(token, hello, { handshakeMs });
  controlledRegistrations.add(connection);
  connection?.once?.("close", () => controlledRegistrations.delete(connection));
  return { registered: true, connection };
}

function infrastructureError(error, fallbackCode = "SUPERVISOR_FAILURE") {
  if (error instanceof SupervisorInfrastructureError) return error;
  return new SupervisorInfrastructureError(
    fallbackCode,
    error?.message ?? String(error),
    { cause: error }
  );
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) ||
      typeof spec.command !== "string" || spec.command.length === 0 ||
      !Array.isArray(spec.args) ||
      spec.args.some((argument) => typeof argument !== "string")) {
    throw new SupervisorInfrastructureError(
      "INVALID_LAUNCH_SPEC",
      "A command and string argument array are required."
    );
  }
  if (spec.shell !== undefined && spec.shell !== false) {
    throw new SupervisorInfrastructureError(
      "SHELL_UNSAFE",
      "Supervised processes require shell: false."
    );
  }
  if (spec.maxBuffer !== undefined &&
      (!Number.isSafeInteger(spec.maxBuffer) ||
       spec.maxBuffer < 0 ||
       spec.maxBuffer > MAX_FRAME_BYTES)) {
    throw new SupervisorInfrastructureError(
      "INVALID_LAUNCH_SPEC",
      `maxBuffer must be an integer between 0 and ${MAX_FRAME_BYTES}.`
    );
  }
  if (spec.timeout !== undefined &&
      (!Number.isSafeInteger(spec.timeout) || spec.timeout < 0)) {
    throw new SupervisorInfrastructureError(
      "INVALID_LAUNCH_SPEC",
      "timeout must be a non-negative integer."
    );
  }
  return { ...spec, shell: false };
}

function validateCapabilities(value, {
  platform,
  mode,
  minimumGuarantee,
  requiresDetached = false
}) {
  const modes = new Set(["cooperative", "host-strict"]);
  const containments = new Set(["cooperative", "kernel"]);
  const proofs = new Set(["registered-drained", "kernel-drained"]);
  if (!value || typeof value !== "object" ||
      value.platform !== platform ||
      typeof value.backend !== "string" || !value.backend ||
      !modes.has(value.mode) ||
      !containments.has(value.containment) ||
      !proofs.has(value.cleanupProof) ||
      typeof value.supportsDetachedDescendants !== "boolean" ||
      (value.mode === "host-strict" &&
        (value.containment !== "kernel" ||
         value.cleanupProof !== "kernel-drained")) ||
      (requiresDetached && !value.supportsDetachedDescendants)) {
    throw new SupervisorInfrastructureError(
      "CAPABILITY_INVALID",
      "Backend capabilities are inconsistent with the requested guarantee."
    );
  }
  return value;
}

function envelope(type, identity, payload) {
  return {
    ...payload,
    version: PROTOCOL_VERSION,
    type,
    epoch: identity.epoch,
    runId: identity.runId,
    nonce: identity.nonce,
    backend: payload?.backend
  };
}

export function createProcessSupervisor({
  mode = "auto",
  minimumGuarantee = "cooperative",
  platform = process.platform,
  backendFactories = defaultBackendFactories,
  discoverRecordedProcesses = async () => [],
  syncBridge = runSynchronous,
  syncBackendSelection = { type: "child-process" }
} = {}) {
  const epoch = randomUUID();
  const leases = new Map();
  const completedSyncRuns = new Map();
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
    try {
      for (const factory of backendFactories) {
        const candidate = await factory({ platform, mode, minimumGuarantee });
        if (!candidate) continue;
        const probe = await candidate.probe();
        if (!probe?.available) continue;
        const candidateCapabilities = validateCapabilities(probe.capabilities, {
          platform,
          mode,
          minimumGuarantee
        });
        if ((mode === "host-strict" || minimumGuarantee === "host-strict") &&
            candidateCapabilities.mode !== "host-strict") {
          continue;
        }
        backend = candidate;
        backendCapabilities = candidateCapabilities;
        return candidateCapabilities;
      }
      throw new SupervisorInfrastructureError(
        "CAPABILITY_UNAVAILABLE",
        `No ${minimumGuarantee} process supervisor backend is available for ${platform}.`
      );
    } catch (error) {
      throw latch(error, "CAPABILITY_PROBE_FAILED");
    }
  })();
  // Capability refusal is consumed by the first public operation or explicit
  // capabilities await; importing the shared facade alone must not create an
  // unhandled rejection.
  void capabilities.catch(() => {});

  function assertCanLaunch() {
    if (shutdownStarted) {
      throw new SupervisorInfrastructureError(
        "SUPERVISOR_SHUTDOWN",
        "The process supervisor has shut down."
      );
    }
    if (latchedFailure) throw latchedFailure;
  }

  function validateTerminal(identity, rootPayload, proofPayload, capabilitiesValue) {
    const root = validateRoot(envelope("root", identity, rootPayload), identity);
    validateCleanup(
      envelope("cleanup", identity, proofPayload),
      identity
    );
    const cleanup = validateProof(
      envelope("proof", identity, proofPayload),
      identity
    );
    const result = createTerminalResult({
      root,
      backend: capabilitiesValue,
      cleanup,
      requestedSignal: identity.requestedSignal ?? null,
      terminationCause: identity.terminationCause ??
        (identity.requestedSignal ? "requested-signal" : "root-exit")
    });
    assertCleanupProven(result, minimumGuarantee);
    if (root.error) {
      throw new SupervisorInfrastructureError(
        "ROOT_PROCESS_ERROR",
        root.error.message ?? "The root process failed to launch.",
        { cause: root.error, result }
      );
    }
    return result;
  }

  async function cleanupLease(lease) {
    if (!lease.cleanupPromise) {
      lease.cleanupPromise = (async () => {
        try {
          const raw = typeof lease.launch.cleanup === "function"
            ? await lease.launch.cleanup()
            : lease.launch.cleanup;
          validateCleanup(envelope("cleanup", lease, raw), lease);
          const proof = validateProof(
            envelope("proof", lease, raw),
            lease
          );
          const provisional = createTerminalResult({
            root: { status: null, signal: null },
            backend: backendCapabilities,
            cleanup: proof
          });
          assertCleanupProven(provisional, minimumGuarantee);
          lease.cleanup = proof;
          return proof;
        } catch (error) {
          throw latch(error, "CLEANUP_FAILED");
        }
      })();
    }
    return lease.cleanupPromise;
  }

  function createFakeLaunch({ root, cleanup, pid = 1 } = {}, identity) {
    const addBackend = (value) => value && typeof value === "object"
      ? { ...value, backend: value.backend ?? identity.backend }
      : value;
    return {
      pid,
      root: Promise.resolve(root).then((value) =>
        new Promise((resolve) => setImmediate(() => resolve(addBackend(value))))),
      cleanup: typeof cleanup === "function"
        ? async () => addBackend(await cleanup())
        : addBackend(cleanup),
      kill() {
        return { backend: identity.backend, stopped: true };
      }
    };
  }

  async function launch(inputSpec) {
    assertCanLaunch();
    const spec = validateSpec(inputSpec);
    const selected = await capabilities;
    validateCapabilities(selected, {
      platform,
      mode,
      minimumGuarantee,
      requiresDetached: spec.detached === true
    });
    assertCanLaunch();
    const identity = {
      epoch,
      runId: randomUUID(),
      nonce: randomUUID(),
      backend: selected.backend
    };
    validateLaunch(envelope("launch", identity, {
      backend: selected.backend,
      command: spec.command,
      args: spec.args
    }), identity);
    let launched;
    try {
      launched = await backend.launch(
        { ...spec, ...identity },
        {
          ...identity,
          assertFrame: assertBoundedFrame,
          createFakeLaunch: (values) => createFakeLaunch(values, identity)
        }
      );
    } catch (error) {
      throw latch(error, "LAUNCH_FAILED");
    }
    if (!launched || !launched.root || !launched.cleanup) {
      throw latch(new SupervisorInfrastructureError(
        "INVALID_BACKEND_LAUNCH",
        "The backend did not return root completion and cleanup proof sources."
      ));
    }
    const lease = {
      ...identity,
      spec,
      launch: launched,
      requestedSignal: null
    };
    leases.set(identity.runId, lease);
    return lease;
  }

  async function settleLease(lease, completedRoot) {
    let root;
    let rootError;
    try {
      try {
        root = completedRoot ?? await lease.launch.root;
        root = validateRoot(envelope("root", lease, root), lease);
      } catch (error) {
        rootError = error;
      }
      const cleanup = await cleanupLease(lease);
      if (rootError) throw rootError;
      if (typeof lease.launch.finalizeRoot === "function") {
        root = validateRoot(
          envelope("root", lease, lease.launch.finalizeRoot(root)),
          lease
        );
      }
      return validateTerminal(
        lease,
        root,
        cleanup,
        backendCapabilities
      );
    } catch (error) {
      throw latch(error, root?.error ? "ROOT_PROCESS_ERROR" : "TRANSPORT_FAILED");
    } finally {
      leases.delete(lease.runId);
    }
  }

  function run(inputSpec) {
    assertCanLaunch();
    const spec = validateSpec(inputSpec);
    if (syncBackendSelection?.type === "child-process" &&
        (mode === "host-strict" || minimumGuarantee === "host-strict")) {
      throw latch(new SupervisorInfrastructureError(
        "CAPABILITY_UNAVAILABLE",
        `The child-process synchronous backend cannot provide ${minimumGuarantee}.`
      ));
    }
    const identity = {
      epoch,
      runId: randomUUID(),
      nonce: randomUUID()
    };
    try {
      const response = syncBridge({
        spec,
        backendSelection: syncBackendSelection,
        platform,
        mode,
        minimumGuarantee,
        ...identity
      });
      const selected = validateCapabilities(response.capabilities, {
        platform,
        mode,
        minimumGuarantee,
        requiresDetached: spec.detached === true
      });
      identity.backend = selected.backend;
      const result = validateTerminal(
        identity,
        response.root,
        response.cleanup,
        selected
      );
      completedSyncRuns.set(identity.runId, {
        identity: { ...identity },
        proof: response.cleanup,
        capabilities: selected
      });
      return result;
    } catch (error) {
      throw latch(error, "SYNC_BRIDGE_FAILED");
    }
  }

  async function spawnTracked(inputSpec) {
    const lease = await launch(inputSpec);
    const child = new EventEmitter();
    child.pid = lease.launch.pid ?? lease.launch.child?.pid;
    child.stdin = lease.launch.stdin ?? lease.launch.child?.stdin ?? null;
    child.stdout = lease.launch.stdout ?? lease.launch.child?.stdout ?? null;
    child.stderr = lease.launch.stderr ?? lease.launch.child?.stderr ?? null;
    child.exitCode = null;
    child.signalCode = null;
    const terminal = createChildTerminalizer(child);
    child.ref = () => {
      (lease.launch.ref ?? lease.launch.child?.ref)?.call(
        lease.launch.child ?? lease.launch
      );
      return child;
    };
    child.unref = () => {
      (lease.launch.unref ?? lease.launch.child?.unref)?.call(
        lease.launch.child ?? lease.launch
      );
      return child;
    };
    let killRequested = false;
    const rawKill = lease.launch.kill ?? lease.launch.child?.kill;
    const requestCancellation = (signal = "SIGTERM", cause = "requested-signal") => {
      if (killRequested || child.exitCode !== null || child.signalCode !== null) {
        return false;
      }
      killRequested = true;
      lease.requestedSignal = signal;
      lease.terminationCause = cause;
      try {
        const stopped = rawKill?.call(
          lease.launch.child ?? lease.launch,
          signal
        );
        validateStop(envelope("stop", lease, stopped), lease);
        return true;
      } catch (error) {
        latch(error, "STOP_FAILED");
        return false;
      }
    };
    child.kill = (signal = "SIGTERM") =>
      requestCancellation(signal, "requested-signal");
    let timeoutTimer;
    if (lease.spec.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        requestCancellation("SIGTERM", "timeout");
      }, lease.spec.timeout);
    }

    let resolveCompletion;
    let rejectCompletion;
    child.completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void (async () => {
      let rawRoot;
      try {
        rawRoot = await lease.launch.root;
        const root = validateRoot(envelope("root", lease, rawRoot), lease);
        if (!root.error) terminal.exit(root.status, root.signal);
        const result = await settleLease(lease, root);
        resolveCompletion(result);
        queueMicrotask(() =>
          terminal.close());
      } catch (error) {
        let terminalError = error;
        if (leases.has(lease.runId)) {
          try {
            await settleLease(lease, rawRoot);
          } catch (settlementError) {
            terminalError = settlementError;
          }
        }
        const normalized = latch(terminalError, "TRANSPORT_FAILED");
        try {
          terminal.error(normalized);
        } finally {
          rejectCompletion(normalized);
          queueMicrotask(() => terminal.close());
        }
      } finally {
        clearTimeout(timeoutTimer);
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
            matching.nonce !== processRecord.nonce ||
            matching.backend !== processRecord.backend) {
          failures.push(latch(new SupervisorInfrastructureError(
            "UNREGISTERED_RECORDED_PROCESS",
            "Discovered process state has no live matching lease and backend.",
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
      for (const completed of completedSyncRuns.values()) {
        try {
          validateCleanup(
            envelope("cleanup", completed.identity, completed.proof),
            completed.identity
          );
          const proof = validateProof(
            envelope("proof", completed.identity, completed.proof),
            completed.identity
          );
          const result = createTerminalResult({
            root: { status: null, signal: null },
            backend: completed.capabilities,
            cleanup: proof
          });
          assertCleanupProven(result, minimumGuarantee);
        } catch (error) {
          failures.push(latch(error, "CLEANUP_FAILED"));
        }
      }
      try {
        await capabilities;
        if (backend.cleanupAll) {
          const raw = await backend.cleanupAll();
          const aggregateIdentity = {
            epoch,
            runId: "aggregate",
            nonce: "aggregate",
            backend: backendCapabilities.backend
          };
          validateCleanup(
            envelope("cleanup", aggregateIdentity, raw),
            aggregateIdentity
          );
          const proof = validateProof(
            envelope("proof", aggregateIdentity, raw),
            aggregateIdentity
          );
          const result = createTerminalResult({
            root: { status: null, signal: null },
            backend: backendCapabilities,
            cleanup: proof
          });
          assertCleanupProven(result, minimumGuarantee);
        }
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
        const evidence = await backend.shutdown();
        if (evidence?.stopped !== true) {
          throw new SupervisorInfrastructureError(
            "SHUTDOWN_UNPROVEN",
            "The backend did not prove that it stopped."
          );
        }
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
    spawnTracked,
    cleanupAll,
    shutdown,
    assertHealthy
  };
}
