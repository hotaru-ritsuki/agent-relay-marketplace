import process from "node:process";

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
  defaultBackendFactories,
  inheritSupervisorEnvironment,
  registerControlledDescendant,
  SUPERVISOR_TOKEN_ENV
} from "./coordinator.mjs";
export { runSynchronous } from "./worker.mjs";
export { createWindowsBackend } from "./backends/windows.mjs";
export {
  createPosixProcessGroupBackend,
  decodeSupervisorToken,
  encodeSupervisorToken
} from "./backends/posix-process-group.mjs";
export { createMacosBackend } from "./backends/macos.mjs";

import { createProcessSupervisor } from "./coordinator.mjs";
import { createMacosBackend } from "./backends/macos.mjs";
import { createPosixProcessGroupBackend } from "./backends/posix-process-group.mjs";
import { createWindowsBackend } from "./backends/windows.mjs";

const sharedBackend = process.platform === "win32"
  ? createWindowsBackend()
  : process.platform === "darwin"
    ? createMacosBackend()
    : createPosixProcessGroupBackend();
const sharedSupervisor = createProcessSupervisor({
  minimumGuarantee: "cooperative",
  backendFactories: [() => sharedBackend],
  ...(process.platform === "win32"
    ? {
        syncBridge: sharedBackend.runSynchronous,
        syncBackendSelection: { type: "windows-job" }
      }
    : {})
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
