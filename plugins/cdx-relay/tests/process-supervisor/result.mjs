import { SupervisorInfrastructureError } from "./errors.mjs";

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
