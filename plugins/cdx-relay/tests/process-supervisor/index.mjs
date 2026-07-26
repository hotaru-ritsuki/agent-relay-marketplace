export {
  SupervisorCleanupError,
  SupervisorInfrastructureError
} from "./errors.mjs";
export {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  assertBoundedFrame,
  validateCleanup,
  validateHello,
  validateLaunch,
  validateProof,
  validateRoot,
  validateStop,
  validators
} from "./protocol.mjs";
export {
  assertCleanupProven,
  createTerminalResult
} from "./result.mjs";
export {
  createProcessSupervisor,
  defaultBackendFactories
} from "./coordinator.mjs";
export { runSynchronous } from "./worker.mjs";
export { createWindowsBackend } from "./backends/windows.mjs";

import { createProcessSupervisor } from "./coordinator.mjs";
import { createWindowsBackend } from "./backends/windows.mjs";

const sharedWindowsBackend = createWindowsBackend();
const sharedSupervisor = createProcessSupervisor({
  minimumGuarantee: "cooperative",
  backendFactories: [() => sharedWindowsBackend],
  syncBridge: sharedWindowsBackend.runSynchronous,
  syncBackendSelection: { type: "windows-job" }
});

function normalizeInvocation(command, args = [], options = {}) {
  if (command && typeof command === "object" && !Array.isArray(command)) {
    if (command.shell !== undefined && command.shell !== false) {
      throw new TypeError("Supervised commands require shell: false.");
    }
    return { ...command, shell: false };
  }
  if (options.shell !== undefined && options.shell !== false) {
    throw new TypeError("Supervised commands require shell: false.");
  }
  return {
    ...options,
    command,
    args,
    shell: false
  };
}

export const run = (...args) =>
  sharedSupervisor.run(normalizeInvocation(...args));
export const spawnTracked = (...args) =>
  sharedSupervisor.spawnTracked(normalizeInvocation(...args));
export const cleanupTrackedChildren = () => sharedSupervisor.cleanupAll();
export const shutdown = () => sharedSupervisor.shutdown();
export const assertSupervisorHealthy = () => sharedSupervisor.assertHealthy();

export function installSupervisorTeardown(afterHook) {
  afterHook(async () => {
    let shutdownError;
    try {
      await sharedSupervisor.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    sharedSupervisor.assertHealthy();
    if (shutdownError) throw shutdownError;
  });
}
