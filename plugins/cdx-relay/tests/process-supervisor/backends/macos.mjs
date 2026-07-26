import { SupervisorInfrastructureError } from "../errors.mjs";
import { createPosixProcessGroupBackend } from "./posix-process-group.mjs";

export function createMacosBackend({
  mode = "auto",
  minimumGuarantee = "cooperative",
  createPosixBackend = createPosixProcessGroupBackend,
  ...options
} = {}) {
  const backend = createPosixBackend({ ...options, platform: "darwin" });
  return {
    ...backend,
    async probe() {
      if (mode === "host-strict" || minimumGuarantee === "host-strict") {
        throw new SupervisorInfrastructureError(
          "CAPABILITY_UNAVAILABLE",
          "macOS cooperative process groups cannot provide host-strict containment."
        );
      }
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

