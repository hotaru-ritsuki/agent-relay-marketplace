import { SupervisorInfrastructureError } from "./errors.mjs";

export function createChildTerminalizer(child, { backend } = {}) {
  if (!child || typeof child.emit !== "function") {
    throw new TypeError("A child-like EventEmitter is required.");
  }
  let terminalEvent = null;
  let closeEmitted = false;
  let resolveRoot;
  const root = backend === undefined
    ? undefined
    : new Promise((resolve) => {
        resolveRoot = resolve;
      });
  const resolveTerminalRoot = ({ status, signal, error }) => {
    resolveRoot?.({
      backend,
      status,
      signal,
      stdout: undefined,
      stderr: undefined,
      error
    });
  };
  const emitError = (error) => {
    if (typeof child.listenerCount === "function" &&
        child.listenerCount("error") === 0) {
      child.once("error", () => {});
    }
    child.emit("error", error);
  };
  return {
    root,
    get terminalEvent() {
      return terminalEvent;
    },
    error(error) {
      if (terminalEvent !== null) return false;
      terminalEvent = "error";
      resolveTerminalRoot({ status: null, signal: null, error });
      emitError(error);
      return true;
    },
    exit(status, signal) {
      if (terminalEvent !== null) return false;
      terminalEvent = "exit";
      child.exitCode = status;
      child.signalCode = signal;
      resolveTerminalRoot({ status, signal, error: undefined });
      child.emit("exit", status, signal);
      return true;
    },
    close() {
      if (closeEmitted) return false;
      closeEmitted = true;
      child.emit(
        "close",
        child.exitCode ?? null,
        child.signalCode ?? null
      );
      return true;
    }
  };
}

export function createTerminalResult({
  root,
  backend,
  cleanup,
  requestedSignal = null,
  terminationCause = "root-exit"
}) {
  return {
    status: root.status ?? null,
    signal: root.signal ?? null,
    stdout: root.stdout,
    stderr: root.stderr,
    error: root.error,
    supervisor: {
      backend: backend.backend,
      mode: backend.mode,
      containment: backend.containment,
      cleanup,
      requestedSignal,
      observedSignal: root.signal ?? null,
      terminationCause
    }
  };
}

export function assertCleanupProven(result, minimumGuarantee) {
  const accepted = minimumGuarantee === "host-strict"
    ? result.supervisor.cleanup?.level === "kernel-drained"
    : ["kernel-drained", "registered-drained"].includes(
      result.supervisor.cleanup?.level
    );
  if (!accepted) {
    throw new SupervisorInfrastructureError(
      "CLEANUP_UNPROVEN",
      `Required ${minimumGuarantee} cleanup was not proven.`,
      { result }
    );
  }
  return result;
}
