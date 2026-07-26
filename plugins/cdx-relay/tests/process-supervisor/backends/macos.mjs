import { SupervisorInfrastructureError } from "../errors.mjs";
import { createPosixProcessGroupBackend } from "./posix-process-group.mjs";

export function createMacosBackend({
  mode = "auto",
  minimumGuarantee = "cooperative",
  createPosixBackend = createPosixProcessGroupBackend,
  ...options
} = {}) {
  const backend = createPosixBackend({ ...options, platform: "darwin" });
  const assertCooperative = () => {
    if (mode === "host-strict" || minimumGuarantee === "host-strict") {
      throw new SupervisorInfrastructureError(
        "CAPABILITY_UNAVAILABLE",
        "macOS cooperative process groups cannot provide host-strict containment."
      );
    }
  };
  const guarded = (operation) => async (...args) => {
    assertCooperative();
    return operation?.(...args);
  };
  return {
    ...backend,
    launch: guarded(backend.launch),
    ...(backend.run ? { run: guarded(backend.run) } : {}),
    cleanup: guarded(backend.cleanup),
    cleanupAll: guarded(backend.cleanupAll),
    shutdown: guarded(backend.shutdown),
    async probe() {
      assertCooperative();
      return {
        available: true,
        capabilities: {
          platform: "darwin",
          backend: "posix-cooperative",
          mode: "cooperative",
          containment: "cooperative",
          cleanupProof: "registered-drained",
          supportsDetachedDescendants: false
        }
      };
    }
  };
}
