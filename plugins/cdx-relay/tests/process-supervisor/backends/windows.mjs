import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

const NATIVE_ROOT = fileURLToPath(new URL("../native/windows/", import.meta.url));
const WORKER_FILE = path.join(NATIVE_ROOT, "worker.mjs");
const CONTROLLER_FILE = path.join(NATIVE_ROOT, "controller.ps1");
const LAUNCH_SHIM_FILE = path.join(NATIVE_ROOT, "launch-shim.mjs");
const WINDOWS_CAPABILITIES = Object.freeze({
  platform: "win32",
  backend: "windows-job",
  mode: "host-strict",
  containment: "kernel",
  cleanupProof: "kernel-drained",
  supportsDetachedDescendants: true
});
const LEASE = Symbol("windows-job-lease");
let windowsJobWorker = null;
let windowsJobWorkerChannel = null;
let windowsJobWorkerReady = null;
let windowsJobPoisonSignal = null;
let windowsJobWorkerExitSignal = null;
let windowsJobControllerInstanceId = null;
let windowsJobControllerPid = null;
let windowsJobShuttingDown = false;
const windowsJobLeases = new Map();
const completedWindowsJobProofs = new Map();

function validateWindowsJobLease(lease) {
  if (!lease || typeof lease !== "object" ||
      typeof lease.controllerInstanceId !== "string" || !lease.controllerInstanceId ||
      typeof lease.launchId !== "string" || !lease.launchId ||
      !Number.isSafeInteger(lease.controllerPid) || lease.controllerPid <= 0 ||
      !(
        Number.isSafeInteger(lease.pid) && lease.pid > 0 ||
        lease.pid === null && lease.spawnError && typeof lease.spawnError === "object"
      ) ||
      !Number.isSafeInteger(lease.maxBuffer) ||
      lease.maxBuffer < 1 || lease.maxBuffer > 64 * 1024 * 1024) {
    throw new TypeError("Windows job lease is invalid.");
  }
}

function clearWindowsJobWorkerRefs() {
  windowsJobWorkerChannel?.port2.close();
  windowsJobWorker = null;
  windowsJobWorkerChannel = null;
  windowsJobWorkerReady = null;
  windowsJobPoisonSignal = null;
  windowsJobWorkerExitSignal = null;
  windowsJobControllerInstanceId = null;
  windowsJobControllerPid = null;
}

function purgeWindowsJobEpoch(instanceId) {
  for (const [launchId, lease] of windowsJobLeases) {
    if (!instanceId || lease.controllerInstanceId === instanceId) {
      windowsJobLeases.delete(launchId);
    }
  }
  for (const [launchId, entry] of completedWindowsJobProofs) {
    if (!instanceId || entry.controllerInstanceId === instanceId) {
      completedWindowsJobProofs.delete(launchId);
    }
  }
}

function consumeWindowsJobTerminalAck(expectedInstanceId, expectedControllerPid) {
  const received = receiveMessageOnPort(windowsJobWorkerChannel.port2);
  const ack = received?.message;
  if (!ack || typeof ack !== "object" ||
      Object.keys(ack).sort().join(",") !==
        "controllerInstanceId,controllerPid,reason,type" ||
      ack.type !== "controller-terminal" ||
      typeof ack.controllerInstanceId !== "string" || !ack.controllerInstanceId ||
      !Number.isSafeInteger(ack.controllerPid) || ack.controllerPid <= 0 ||
      (expectedInstanceId !== null &&
        ack.controllerInstanceId !== expectedInstanceId) ||
      (expectedControllerPid !== null &&
        ack.controllerPid !== expectedControllerPid) ||
      typeof ack.reason !== "string") {
    throw new Error("Windows job Worker terminal acknowledgement was invalid.");
  }
  return ack;
}

function awaitWindowsJobWorkerExit(timeoutMs = 1000) {
  const exitState = new Int32Array(windowsJobWorkerExitSignal);
  const exitWait = Atomics.load(exitState, 0) === 1
    ? "not-equal"
    : Atomics.wait(exitState, 0, 0, timeoutMs);
  if (exitWait === "timed-out" || Atomics.load(exitState, 0) !== 1) {
    throw new Error("Windows job Worker shutdown was not confirmed.");
  }
}

function finalizeUnexpectedWindowsJobWorker() {
  if (!windowsJobWorker || !windowsJobPoisonSignal) return false;
  const state = new Int32Array(windowsJobPoisonSignal);
  if (Atomics.load(state, 0) !== 3) return false;
  const instanceId = windowsJobControllerInstanceId;
  const controllerPid = windowsJobControllerPid;
  awaitWindowsJobWorkerExit();
  const ack = consumeWindowsJobTerminalAck(instanceId, controllerPid);
  purgeWindowsJobEpoch(ack.controllerInstanceId);
  clearWindowsJobWorkerRefs();
  return true;
}

function poisonWindowsJobWorker(timeoutMs = 3000) {
  if (!windowsJobWorker || !windowsJobPoisonSignal) return;
  if (finalizeUnexpectedWindowsJobWorker()) return;
  const poisonedInstanceId = windowsJobControllerInstanceId;
  const poisonedControllerPid = windowsJobControllerPid;
  const state = new Int32Array(windowsJobPoisonSignal);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
  const wait = Atomics.wait(state, 0, 1, timeoutMs);
  const controllerConfirmed = wait !== "timed-out" && Atomics.load(state, 0) === 2;
  if (!controllerConfirmed) {
    throw new Error("Windows job transport poison shutdown was not confirmed.");
  }
  awaitWindowsJobWorkerExit();
  const ack = consumeWindowsJobTerminalAck(
    poisonedInstanceId, poisonedControllerPid
  );
  purgeWindowsJobEpoch(ack.controllerInstanceId);
  clearWindowsJobWorkerRefs();
}

function getWindowsJobWorker() {
  finalizeUnexpectedWindowsJobWorker();
  if (!windowsJobWorker) {
    windowsJobWorkerReady = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    windowsJobPoisonSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    windowsJobWorkerExitSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    windowsJobWorkerChannel = new MessageChannel();
    windowsJobWorker = new Worker(WORKER_FILE, {
      execArgv: [],
      transferList: [windowsJobWorkerChannel.port1],
      workerData: {
        controllerScript: CONTROLLER_FILE,
        shimScript: LAUNCH_SHIM_FILE,
        readySignal: windowsJobWorkerReady,
        poisonSignal: windowsJobPoisonSignal,
        exitSignal: windowsJobWorkerExitSignal,
        requestPort: windowsJobWorkerChannel.port1
      }
    });
    windowsJobWorker.unref();
    windowsJobWorkerChannel.port2.unref();
    const worker = windowsJobWorker;
    const notifyWorkerLoss = () => {
      if (worker !== windowsJobWorker || !windowsJobPoisonSignal) return;
      const state = new Int32Array(windowsJobPoisonSignal);
      Atomics.store(state, 0, 3);
      Atomics.notify(state, 0);
    };
    worker.once("error", notifyWorkerLoss);
    worker.once("exit", notifyWorkerLoss);
  }
  const readyState = new Int32Array(windowsJobWorkerReady);
  if (Atomics.load(readyState, 0) === 0) {
    const readyResult = Atomics.wait(readyState, 0, 0, 5000);
    if (readyResult === "timed-out") {
      poisonWindowsJobWorker();
      throw new Error("Windows job controller Worker startup deadline expired.");
    }
  }
  return windowsJobWorker;
}

function requestWindowsJobWorker(operation, payload, timeoutMs) {
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
  const state = new Int32Array(shared);
  const { port1, port2 } = new MessageChannel();
  getWindowsJobWorker();
  windowsJobWorkerChannel.port2.postMessage(
    { operation, payload, port: port1, shared },
    [port1]
  );
  const waitResult = Atomics.wait(state, 0, 0, timeoutMs);
  if (waitResult === "timed-out") {
    port2.close();
    if (!finalizeUnexpectedWindowsJobWorker()) poisonWindowsJobWorker();
    throw new Error(
      `Windows job controller ${operation} deadline expired at stages ` +
      `${Atomics.load(state, 1)}/${Atomics.load(state, 2)}/${Atomics.load(state, 3)}.`
    );
  }
  const received = receiveMessageOnPort(port2);
  port2.close();
  if (!received) {
    if (!finalizeUnexpectedWindowsJobWorker()) poisonWindowsJobWorker();
    throw new Error(`Windows job controller ${operation} returned no response.`);
  }
  if (received.message.error) {
    if (!finalizeUnexpectedWindowsJobWorker()) poisonWindowsJobWorker();
    throw new Error(received.message.error);
  }
  return received.message.value;
}

function requestWindowsJobWorkerAsync(operation, payload, timeoutMs) {
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
  const { port1, port2 } = new MessageChannel();
  getWindowsJobWorker();
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      port2.close();
      try {
        if (!finalizeUnexpectedWindowsJobWorker()) poisonWindowsJobWorker();
      } catch (error) {
        reject(error);
        return;
      }
      reject(new Error(`Windows job controller ${operation} deadline expired.`));
    }, timeoutMs);
    port2.once("message", (message) => {
      clearTimeout(timer);
      port2.close();
      if (message.error) {
        try {
          if (!finalizeUnexpectedWindowsJobWorker()) poisonWindowsJobWorker();
        } catch (error) {
          reject(error);
          return;
        }
        reject(new Error(message.error));
      } else {
        resolve(message.value);
      }
    });
    windowsJobWorkerChannel.port2.postMessage(
      { operation, payload, port: port1, shared },
      [port1]
    );
  });
  return {
    promise,
    ref() {
      port2.ref();
      timer?.ref();
    },
    unref() {
      port2.unref();
      timer?.unref();
    }
  };
}

function launchWindowsJob(command, args, options = {}) {
  if (typeof command !== "string" || !command ||
      !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("spawnTracked requires a command and string args.");
  }
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBuffer) ||
      maxBuffer < 1 || maxBuffer > 64 * 1024 * 1024) {
    throw new RangeError("maxBuffer must be a bounded integer.");
  }
  const controlTimeout = options.controlTimeout ?? 7000;
  const lease = requestWindowsJobWorker(
    "launch",
    {
      launch: {
        command,
        args,
        options: {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          detached: options.detached ?? false,
          windowsHide: options.windowsHide ?? true,
          timeout: options.timeout,
          maxBuffer
        },
        input: { type: "string", value: "" },
        testFault: options.controllerFault,
          faultPidFile: options.faultPidFile,
          handshakePid: options.handshakePid
      },
      controlTimeout
    },
    controlTimeout + 1000
  );
  lease.maxBuffer = maxBuffer;
  lease.controlTimeout = controlTimeout;
  windowsJobLeases.set(lease.launchId, lease);
  windowsJobControllerInstanceId = lease.controllerInstanceId;
  windowsJobControllerPid = lease.controllerPid;
  return lease;
}

function createWindowsSpawnError(descriptor, { synchronous = true } = {}) {
  const originalSyscall = typeof descriptor.syscall === "string"
    ? descriptor.syscall
    : null;
  const syscall = synchronous
    ? originalSyscall?.replace(/^spawn(?= |$)/, "spawnSync") ?? null
    : originalSyscall;
  const message = syscall && originalSyscall !== syscall
    ? String(descriptor.message).replace(originalSyscall, syscall)
    : String(descriptor.message ?? descriptor.code ?? "Windows process failed");
  const error = new Error(message);
  for (const key of ["code", "errno", "path", "spawnargs"]) {
    if (descriptor[key] !== undefined && descriptor[key] !== null) {
      error[key] = descriptor[key];
    }
  }
  if (syscall) error.syscall = syscall;
  return error;
}

export function runWindowsJobForTest(command, args, options = {}) {
  if (process.platform !== "win32") {
    throw new Error("The Windows job controller is only available on Windows.");
  }
  if (typeof command !== "string" || !command) {
    throw new TypeError("command must be a nonempty string.");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("args must be an array of strings.");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object.");
  }
  if (options.shell !== undefined && options.shell !== false) {
    throw new TypeError("shell must be false for Windows job launches.");
  }
  if (options.detached !== undefined && typeof options.detached !== "boolean") {
    throw new TypeError("detached must be a boolean.");
  }
  if (options.windowsHide !== undefined && typeof options.windowsHide !== "boolean") {
    throw new TypeError("windowsHide must be a boolean.");
  }
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || !options.cwd)) {
    throw new TypeError("cwd must be a nonempty string.");
  }
  if (options.env !== undefined &&
      (options.env === null || typeof options.env !== "object" ||
       Array.isArray(options.env) ||
       Object.values(options.env).some((value) => typeof value !== "string"))) {
    throw new TypeError("env must be an object with string values.");
  }
  const encoding = options.encoding === null ? null : options.encoding ?? "utf8";
  if (encoding !== null &&
      (typeof encoding !== "string" || !Buffer.isEncoding(encoding))) {
    throw new TypeError("encoding must be a valid Buffer encoding or null.");
  }
  let input;
  if (options.input === undefined || options.input === null || typeof options.input === "string") {
    input = { type: "string", value: options.input ?? "" };
  } else if (Buffer.isBuffer(options.input) || ArrayBuffer.isView(options.input)) {
    input = {
      type: "base64",
      value: Buffer.from(
        options.input.buffer,
        options.input.byteOffset,
        options.input.byteLength
      ).toString("base64")
    };
  } else {
    throw new TypeError("input must be a string, Buffer, or TypedArray.");
  }
  const validateBoundedInteger = (name, value, minimum, maximum) => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) {
      throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
  };
  validateBoundedInteger("timeout", options.timeout, 1, 24 * 60 * 60 * 1000);
  validateBoundedInteger("controlTimeout", options.controlTimeout, 100, 30000);
  validateBoundedInteger("maxBuffer", options.maxBuffer, 1, 64 * 1024 * 1024);
  if (windowsJobLeases.size >= 128) {
    throw new Error("Windows job lease limit reached; explicit cleanup is required.");
  }
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  let lease;
  let transportPoisoned = false;
  try {
    lease = requestWindowsJobWorker(
      "launch",
      {
        launch: {
          command,
          args,
          options: {
            cwd: options.cwd,
            env: options.env,
            shell: options.shell ?? false,
            detached: options.detached ?? false,
            windowsHide: options.windowsHide ?? true,
            timeout: options.timeout,
            maxBuffer
          },
          input,
          testFault: options.controllerFault,
          faultPidFile: options.faultPidFile,
          controllerPidFile: options.controllerPidFile,
          handshakePid: options.handshakePid
        },
        controlTimeout: options.controlTimeout ?? 7000,
        workerFault: options.workerFault
      },
      (options.controlTimeout ?? 7000) + 1000
    );
    windowsJobLeases.set(lease.launchId, lease);
    lease.maxBuffer = maxBuffer;
    windowsJobControllerInstanceId = lease.controllerInstanceId;
    windowsJobControllerPid = lease.controllerPid;
    lease.controlTimeout = options.controlTimeout ?? 7000;
    lease.concurrentCleanup = options.controllerFault === "concurrent-cleanup";
    const waitTimeout = options.timeout === undefined
      ? 30000
      : options.timeout + (options.controlTimeout ?? 1000);
    let result;
    try {
      result = requestWindowsJobWorker(
        "wait",
        { lease, controlTimeout: waitTimeout },
        waitTimeout + 500
      );
    } catch (error) {
      transportPoisoned = /deadline expired|poison shutdown/i.test(error.message);
      error.launchId = lease.launchId;
      throw error;
    }
    if (typeof result.stdoutBase64 !== "string" || typeof result.stderrBase64 !== "string") {
      throw new Error("Controller returned an invalid output snapshot.");
    }
    const stdout = Buffer.from(result.stdoutBase64, "base64");
    const stderr = Buffer.from(result.stderrBase64, "base64");
    if (stdout.length + stderr.length > maxBuffer ||
        stdout.length > maxBuffer || stderr.length > maxBuffer) {
      throw new Error("Controller returned an output snapshot beyond maxBuffer.");
    }
    const error = result.error ? createWindowsSpawnError(result.error) : undefined;
    const response = {
      ...result,
      pid: lease.spawnError ? 0 : lease.pid,
      error,
      stdout: lease.spawnError
        ? undefined
        : encoding === null ? stdout : stdout.toString(encoding),
      stderr: lease.spawnError
        ? undefined
        : encoding === null ? stderr : stderr.toString(encoding),
      ...lease,
      pid: lease.spawnError ? 0 : lease.pid,
      lease
    };
    if (lease.spawnError) {
      cleanupWindowsJobForTest(lease);
    }
    return response;
  } catch (error) {
    if (lease && !transportPoisoned) {
      try {
        cleanupWindowsJobForTest(lease);
      } catch (cleanupError) {
        error.message += `; cleanup failed: ${cleanupError.message}`;
      }
    } else if (lease && transportPoisoned) {
      windowsJobLeases.delete(lease.launchId);
    }
    throw error;
  }
}

export function cleanupWindowsJobForTest(leaseOrLaunchId) {
  const suppliedLease = typeof leaseOrLaunchId === "object" && leaseOrLaunchId
    ? leaseOrLaunchId
    : null;
  if (suppliedLease) validateWindowsJobLease(suppliedLease);
  const lease = suppliedLease
    ? windowsJobLeases.get(suppliedLease.launchId)
    : windowsJobLeases.get(leaseOrLaunchId);
  if (!lease && suppliedLease) {
    const completed = completedWindowsJobProofs.get(suppliedLease.launchId);
    if (completed?.controllerInstanceId === suppliedLease.controllerInstanceId &&
        completed?.controllerPid === suppliedLease.controllerPid) {
      return completed.proof;
    }
  }
  if (!lease) throw new Error(`Unknown Windows job launch: ${leaseOrLaunchId}`);
  validateWindowsJobLease(lease);
  const launchId = lease.launchId;
  let proof;
  try {
    proof = requestWindowsJobWorker(
      "cleanup",
      {
        lease,
        controlTimeout: lease.controlTimeout ?? 7000,
        concurrent: lease.concurrentCleanup === true
      },
      (lease.controlTimeout ?? 7000) + 500
    );
  } catch (error) {
    if (!/not confirmed/i.test(error.message)) windowsJobLeases.delete(launchId);
    throw error;
  }
  if (
    proof.controllerInstanceId !== lease.controllerInstanceId ||
    proof.controllerPid !== lease.controllerPid ||
    proof.launchId !== launchId ||
    proof.status !== "stopped" ||
    proof.activeProcesses !== 0 ||
    proof.tombstone !== true
  ) {
    poisonWindowsJobWorker();
    windowsJobLeases.delete(launchId);
    throw new Error("Windows job cleanup returned invalid terminal proof.");
  }
  windowsJobLeases.delete(launchId);
  completedWindowsJobProofs.set(launchId, {
    controllerInstanceId: lease.controllerInstanceId,
    controllerPid: lease.controllerPid,
    proof
  });
  while (completedWindowsJobProofs.size > 128) {
    completedWindowsJobProofs.delete(completedWindowsJobProofs.keys().next().value);
  }
  return proof;
}


function normalizeWindowsChildSignal(signal) {
  if (signal === 0) return { probe: true, requested: 0, reported: null };
  let name;
  if (typeof signal === "number") {
    name = Object.entries(os.constants.signals)
      .find(([, value]) => value === signal)?.[0];
  } else if (typeof signal === "string") {
    name = signal.toUpperCase();
    if (!(name in os.constants.signals)) name = undefined;
  }
  if (!name) {
    const error = new TypeError(`Unknown signal: ${signal}`);
    error.code = "ERR_UNKNOWN_SIGNAL";
    throw error;
  }
  return {
    probe: false,
    requested: name,
    reported: name === "SIGTERM" || name === "SIGINT" || name === "SIGKILL"
      ? name
      : "SIGKILL"
  };
}

async function legacySpawnTracked(command, args, options = {}) {
  if (process.platform !== "win32") {
    return trackChild(spawn(command, args, options));
  }
  const stdio = options.stdio ?? ["pipe", "pipe", "pipe"];
  let stdoutPiped;
  let stderrPiped;
  if (stdio === "ignore") {
    stdoutPiped = false;
    stderrPiped = false;
  } else if (Array.isArray(stdio) && stdio.length === 3 &&
      stdio[0] === "ignore" &&
      (stdio[1] === "ignore" || stdio[1] === "pipe") &&
      (stdio[2] === "ignore" || stdio[2] === "pipe")) {
    stdoutPiped = stdio[1] === "pipe";
    stderrPiped = stdio[2] === "pipe";
  } else {
    throw new Error(
      "spawnTracked on Windows supports only ignore or [ignore, pipe|ignore, pipe|ignore] stdio without IPC."
    );
  }
  const lease = launchWindowsJob(command, args, options);
  const child = new EventEmitter();
  child[LEASE] = lease;
  child.pid = lease.spawnError ? undefined : lease.pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = stdoutPiped ? new PassThrough({ emitClose: false }) : null;
  child.stderr = stderrPiped ? new PassThrough({ emitClose: false }) : null;
  let requestedSignal = null;
  const waitRequest = requestWindowsJobWorkerAsync(
    "wait",
    {
      lease,
      controlTimeout: options.timeout === undefined
        ? 24 * 60 * 60 * 1000
        : options.timeout + lease.controlTimeout
    },
    (options.timeout === undefined
      ? 24 * 60 * 60 * 1000
      : options.timeout + lease.controlTimeout) + 500
  );
  child.ref = () => {
    waitRequest.ref();
    return child;
  };
  child.unref = () => {
    waitRequest.unref();
    return child;
  };
  child.kill = (signal = "SIGTERM") => {
    if (lease.spawnError) return false;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const normalized = normalizeWindowsChildSignal(signal);
    if (normalized.probe) {
      try {
        process.kill(child.pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    try {
      requestedSignal = normalized.reported;
      cleanupWindowsJobForTest(lease);
      return true;
    } catch (error) {
      queueMicrotask(() => child.emit("error", error));
      return false;
    }
  };

  const closeStreams = async (outputs) => {
    const streams = outputs.filter(({ stream }) => stream);
    await Promise.all(streams.map(({ stream, output }) => new Promise((resolve) => {
      stream.once("finish", () => {
        stream.emit("close");
        resolve();
      });
      stream.end(output);
    })));
  };
  waitRequest.promise.then(async (result) => {
    const stdout = Buffer.from(result.stdoutBase64, "base64");
    const stderr = Buffer.from(result.stderrBase64, "base64");
    if (lease.spawnError) {
      cleanupWindowsJobForTest(lease);
      const error = createWindowsSpawnError(result.error ?? lease.spawnError, {
        synchronous: false
      });
      child.emit("error", error);
      await closeStreams([
        { stream: child.stdout, output: Buffer.alloc(0) },
        { stream: child.stderr, output: Buffer.alloc(0) }
      ]);
      child.emit("close", null, null);
      return;
    }
    child.exitCode = requestedSignal ? null : result.status;
    child.signalCode = requestedSignal ?? result.signal;
    child.emit("exit", child.exitCode, child.signalCode);
    await closeStreams([
      { stream: child.stdout, output: stdout },
      { stream: child.stderr, output: stderr }
    ]);
    child.emit("close", child.exitCode, child.signalCode);
  }, (error) => {
    if (windowsJobShuttingDown) {
      return;
    }
    child.stdout?.destroy(error);
    child.stderr?.destroy(error);
    child.emit("error", error);
    child.emit("close", null, null);
  });
  return child;
}

export function getWindowsJobLeaseCount() {
  return windowsJobLeases.size;
}

function controllerBootstrapAvailable() {
  if (process.platform !== "win32") return false;
  const probe = spawnSync("pwsh.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "if (Get-Command Add-Type -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
  ], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 5_000
  });
  return !probe.error && probe.status === 0;
}

function faultsFor(spec, faults) {
  const configured = typeof faults === "function" ? faults(spec) : faults;
  return configured && typeof configured === "object" ? configured : {};
}

function launchOptions(spec, faults) {
  return {
    cwd: spec.cwd,
    env: spec.env,
    input: spec.input,
    encoding: spec.encoding,
    timeout: spec.timeout,
    maxBuffer: spec.maxBuffer,
    controlTimeout: spec.controlTimeout,
    detached: spec.detached,
    windowsHide: spec.windowsHide,
    stdio: spec.stdio,
    shell: false,
    ...faultsFor(spec, faults)
  };
}

function cleanupProof(spec, proof) {
  return {
    backend: "windows-job",
    level: "kernel-drained",
    controllerEpoch: proof.controllerInstanceId,
    runId: spec.runId,
    nonce: spec.nonce,
    terminalState: proof.status,
    activeProcesses: proof.activeProcesses
  };
}

function stopInfrastructure(faults = {}) {
  windowsJobShuttingDown = true;
  try {
    if (windowsJobWorker) poisonWindowsJobWorker(4_000);
    if (faults.shutdownStopFailure === true) {
      throw new Error(
        "Injected Windows backend infrastructure stop failure."
      );
    }
  } finally {
    windowsJobShuttingDown = false;
  }
}

export function createWindowsBackend({ faults = {} } = {}) {
  const launch = async (spec) => {
    const child = await legacySpawnTracked(
      spec.command,
      spec.args ?? [],
      launchOptions(spec, faults)
    );
    const lease = child[LEASE];
    let rootError;
    const root = new Promise((resolve) => {
      child.once("error", (error) => {
        rootError = error;
        if (!lease || lease.spawnError) {
          resolve({
            backend: "windows-job",
            status: null,
            signal: null,
            stdout: undefined,
            stderr: undefined,
            error
          });
        }
      });
      child.once("exit", (status, signal) => {
        resolve({
          backend: "windows-job",
          status,
          signal,
          stdout: undefined,
          stderr: undefined,
          error: rootError
        });
      });
    });
    return {
      child,
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      root,
      kill(signal) {
        return {
          backend: "windows-job",
          stopped: child.kill(signal)
        };
      },
      cleanup() {
        return cleanupProof(spec, cleanupWindowsJobForTest(lease));
      }
    };
  };

  const cleanup = async () => {
    const shutdownFaults = faultsFor({ operation: "cleanup" }, faults);
    if (shutdownFaults.shutdownCleanupFailure === true) {
      throw new Error(
        "Injected Windows backend shutdown cleanup failure."
      );
    }
    for (const lease of [...windowsJobLeases.values()]) {
      cleanupWindowsJobForTest(lease);
    }
    return {
      backend: "windows-job",
      level: "kernel-drained"
    };
  };

  return {
    async probe() {
      return {
        available: process.platform === "win32" &&
          controllerBootstrapAvailable(),
        capabilities: { ...WINDOWS_CAPABILITIES }
      };
    },
    launch,
    cleanup,
    cleanupAll: cleanup,
    async shutdown() {
      let cleanupError;
      let stopError;
      try {
        await cleanup();
      } catch (error) {
        cleanupError = error;
      }
      try {
        stopInfrastructure(faultsFor({ operation: "shutdown" }, faults));
      } catch (error) {
        stopError = error;
      }
      if (cleanupError) {
        if (stopError) {
          cleanupError.message += `; infrastructure stop failed: ${stopError.message}`;
        }
        throw cleanupError;
      }
      if (stopError) throw stopError;
      return { stopped: true };
    },
    test: {
      runWindowsJobForTest,
      cleanupWindowsJobForTest,
      getWindowsJobLeaseCount
    }
  };
}

export function runWindowsSynchronous(request, { faults = {} } = {}) {
  const result = runWindowsJobForTest(
    request.spec.command,
    request.spec.args ?? [],
    launchOptions(request.spec, faults)
  );
  const proof = cleanupWindowsJobForTest(result.lease);
  return {
    capabilities: { ...WINDOWS_CAPABILITIES },
    root: {
      backend: "windows-job",
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error
    },
    cleanup: cleanupProof(request, proof)
  };
}
