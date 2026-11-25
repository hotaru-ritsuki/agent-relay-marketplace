import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { workerData } from "node:worker_threads";

let controller = null;
let controllerInstanceId = null;
let controllerReady = null;
let controllerInput = Buffer.alloc(0);
let controllerError = "";
let nextRequestId = 1;
const pending = new Map();
const poisonState = new Int32Array(workerData.poisonSignal);
const exitState = new Int32Array(workerData.exitSignal);
let poisoning = false;
let terminal = false;
let terminalAckSent = false;
let requestPort;
process.on("exit", () => {
  Atomics.store(exitState, 0, 1);
  Atomics.notify(exitState, 0);
});

function settlePort(port, shared, value, error = null) {
  port.postMessage(error ? { error: error.message } : { value });
  const state = new Int32Array(shared);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
}

function rejectPending(error) {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  pending.clear();
}

function markControllerPoisoned(reason) {
  controllerReady?.reject(reason);
  controllerReady = null;
  rejectPending(reason);
}

function sendTerminalAck(controllerIdentity, reason) {
  if (terminalAckSent || !requestPort) return;
  terminalAckSent = true;
  requestPort.postMessage({
    type: "controller-terminal",
    controllerInstanceId: controllerIdentity.instanceId,
    controllerPid: controllerIdentity.pid,
    reason: String(reason?.message ?? reason ?? "controller terminal").slice(0, 4096)
  });
}

function recordControllerExit(child, reason) {
  if (controller !== child) return;
  const identity = {
    instanceId: controllerInstanceId,
    pid: child.pid
  };
  controller = null;
  controllerInstanceId = null;
  controllerReady = null;
  controllerInput = Buffer.alloc(0);
  rejectPending(reason);
  terminal = true;
  sendTerminalAck(identity, reason);
  Atomics.store(poisonState, 0, 3);
  Atomics.notify(poisonState, 0);
  requestPort?.close();
  setImmediate(() => process.exit(0));
}

async function shutdownController() {
  const active = controller;
  const identity = {
    instanceId: controllerInstanceId,
    pid: active?.pid ?? null
  };
  controller = null;
  controllerInstanceId = null;
  controllerReady = null;
  controllerInput = Buffer.alloc(0);
  if (!active) return identity;
  const exited = new Promise((resolve) => {
    if (active.exitCode !== null || active.signalCode !== null) resolve(true);
    else active.once("exit", () => resolve(true));
  });
  const waitForExit = (timeoutMs) => Promise.race([
    exited,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    })
  ]);
  active.stdin.end();
  if (!await waitForExit(1500)) {
    active.kill();
    if (!await waitForExit(1500)) {
      throw new Error("Windows job controller forced shutdown was not confirmed.");
    }
  }
  rejectPending(new Error("Windows job controller shut down."));
  return identity;
}

async function servicePoison() {
  if (poisoning || Atomics.load(poisonState, 0) !== 1) return;
  poisoning = true;
  try {
    terminal = true;
    const identity = await shutdownController();
    sendTerminalAck(identity, new Error("Windows job controller poisoned."));
    Atomics.store(poisonState, 0, 2);
  } catch {
    Atomics.store(poisonState, 0, 3);
  } finally {
    Atomics.notify(poisonState, 0);
    poisoning = false;
    if (Atomics.load(poisonState, 0) === 2) {
      setImmediate(() => process.exit(0));
    }
  }
}
const poisonPoll = setInterval(servicePoison, 10);
poisonPoll.unref();

function writeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > 4 * 1024 * 1024) {
    throw new Error("Controller request exceeds the 4 MiB frame limit.");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return new Promise((resolve, reject) => {
    controller.stdin.write(Buffer.concat([header, payload]), (error) => {
      if (error) {
        markControllerPoisoned(error);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

const OWNERSHIP_FIELDS = Object.freeze(["epoch", "runId", "nonce", "backend"]);

function validateOwnership(ownership) {
  if (!hasExactKeys(ownership, OWNERSHIP_FIELDS) ||
      OWNERSHIP_FIELDS.some((field) =>
        typeof ownership[field] !== "string" || !ownership[field]
      )) {
    throw new Error("Controller ownership tuple is invalid.");
  }
  return ownership;
}

function sameOwnership(left, right) {
  return OWNERSHIP_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Controller returned non-canonical base64 output.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Controller returned non-canonical base64 output.");
  }
  return decoded;
}

function handleOutputChunk(message) {
  if (!hasExactKeys(message, [
    "type", "requestId", "action", "controllerInstanceId",
    "stream", "sequence", "dataBase64"
  ]) ||
      message.type !== "output-chunk" ||
      !Number.isSafeInteger(message.requestId) ||
      message.action !== "wait" ||
      message.controllerInstanceId !== controllerInstanceId ||
      (message.stream !== "stdout" && message.stream !== "stderr") ||
      !Number.isSafeInteger(message.sequence) || message.sequence < 0) {
    throw new Error("Controller returned an invalid output-chunk frame.");
  }
  const waiter = pending.get(message.requestId);
  if (!waiter || waiter.type !== "wait") {
    throw new Error("Controller returned output for an unknown request.");
  }
  const chunks = waiter.output[message.stream];
  if (message.sequence !== chunks.length) {
    throw new Error("Controller returned a duplicate or out-of-sequence output chunk.");
  }
  const decoded = decodeCanonicalBase64(message.dataBase64);
  if (decoded.length > 512 * 1024) {
    throw new Error("Controller returned an oversized output chunk.");
  }
  waiter.output.total += decoded.length;
  if (waiter.output.total > waiter.maxBuffer) {
    throw new Error("Controller output exceeded the validated maxBuffer.");
  }
  chunks.push(decoded);
}

function validateOutputProof(proof, chunks, stream) {
  if (!proof || typeof proof !== "object" ||
      !hasExactKeys(proof, ["length", "sha256", "chunkCount"]) ||
      !Number.isSafeInteger(proof.length) || proof.length < 0 ||
      !Number.isSafeInteger(proof.chunkCount) || proof.chunkCount < 0 ||
      typeof proof.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(proof.sha256) ||
      proof.chunkCount !== chunks.length) {
    throw new Error(`Controller returned an invalid ${stream} output proof.`);
  }
  const value = Buffer.concat(chunks);
  const hash = createHash("sha256").update(value).digest("hex");
  if (value.length !== proof.length || hash !== proof.sha256) {
    throw new Error(`Controller returned a mismatched ${stream} output proof.`);
  }
  return value;
}

function finalizeWaitResponse(message, waiter) {
  const result = message.result;
  if (!result || typeof result !== "object" ||
      !hasExactKeys(result, [
        "epoch", "runId", "nonce", "backend",
        "status", "signal", "error", "stdout", "stderr"
      ]) ||
      !sameOwnership(result, validateOwnership(waiter.ownership)) ||
      !(result.status === null ||
        Number.isSafeInteger(result.status) &&
        result.status >= 0 && result.status <= 0xffffffff) ||
      result.signal !== null ||
      !(result.error === null ||
        result.error && typeof result.error === "object" &&
        (
          hasExactKeys(result.error, ["message", "code"]) ||
          hasExactKeys(result.error, [
            "message", "code", "errno", "syscall", "path", "spawnargs"
          ])
        ) &&
        typeof result.error.message === "string" &&
        typeof result.error.code === "string" &&
        (
          !("spawnargs" in result.error) ||
          (
            (result.error.errno === null || Number.isInteger(result.error.errno)) &&
            (result.error.syscall === null || typeof result.error.syscall === "string") &&
            typeof result.error.path === "string" &&
            Array.isArray(result.error.spawnargs) &&
            result.error.spawnargs.every((arg) => typeof arg === "string")
          )
        ))) {
    throw new Error("Controller returned an invalid wait result.");
  }
  const stdout = validateOutputProof(
    result.stdout, waiter.output.stdout, "stdout"
  );
  const stderr = validateOutputProof(
    result.stderr, waiter.output.stderr, "stderr"
  );
  if (stdout.length + stderr.length > waiter.maxBuffer) {
    throw new Error("Controller output proof exceeded the validated maxBuffer.");
  }
  return {
    ...message,
    result: {
      epoch: result.epoch,
      runId: result.runId,
      nonce: result.nonce,
      backend: result.backend,
      status: result.status,
      signal: result.signal,
      error: result.error,
      stdoutBase64: stdout.toString("base64"),
      stderrBase64: stderr.toString("base64")
    }
  };
}

function handleFrame(message) {
  if (!message || typeof message !== "object") {
    throw new Error("Controller returned a non-object frame.");
  }
  if (message.type === "ready") {
    if (!hasExactKeys(message, ["type", "controllerInstanceId"]) ||
        typeof message.controllerInstanceId !== "string" ||
        !message.controllerInstanceId) {
      throw new Error("Controller returned an invalid ready frame.");
    }
    controllerInstanceId = message.controllerInstanceId;
    controllerReady?.resolve(message);
    controllerReady = null;
    return;
  }
  if (message.type === "output-chunk") {
    handleOutputChunk(message);
    return;
  }
  if (!Number.isSafeInteger(message.requestId) ||
      (message.status !== "ok" && message.status !== "error")) {
    throw new Error("Controller returned a structurally invalid response.");
  }
  const waiter = pending.get(message.requestId);
  if (!waiter) {
    throw new Error("Controller returned a response for an unknown request.");
  }
  if (message.controllerInstanceId !== controllerInstanceId) {
    throw new Error("Controller response instance did not match its request.");
  }
  if (message.action !== waiter.type) {
    throw new Error("Controller response action did not match its request.");
  }
  if (message.status === "error") {
    if (!hasExactKeys(message, [
      "requestId", "action", "controllerInstanceId", "status", "reason"
    ]) || typeof message.reason !== "string") {
      throw new Error("Controller returned an invalid error response.");
    }
    pending.delete(message.requestId);
    clearTimeout(waiter.timer);
    waiter.reject(new Error(message.reason ?? "controller request failed"));
  } else {
    const expectedKeys = waiter.type === "launch"
      ? [
          "requestId", "action", "controllerInstanceId", "status",
          "launchId", "ownership", "pid", "spawnError"
        ]
      : ["requestId", "action", "controllerInstanceId", "status", "result"];
    if (!hasExactKeys(message, expectedKeys)) {
      throw new Error(`Controller returned an invalid ${waiter.type} response.`);
    }
    const resolved = waiter.type === "wait"
      ? finalizeWaitResponse(message, waiter)
      : message;
    pending.delete(message.requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(resolved);
  }
}

function consumeFrames(chunk) {
  controllerInput = Buffer.concat([controllerInput, chunk]);
  while (controllerInput.length >= 4) {
    const length = controllerInput.readUInt32LE(0);
    if (length > 4 * 1024 * 1024) {
      markControllerPoisoned(new Error("Controller returned an oversized frame."));
      return;
    }
    if (controllerInput.length < 4 + length) return;
    const payload = controllerInput.subarray(4, 4 + length);
    controllerInput = controllerInput.subarray(4 + length);
    try {
      handleFrame(JSON.parse(payload.toString("utf8")));
    } catch (error) {
      markControllerPoisoned(error);
      return;
    }
  }
}

function startController() {
  if (terminal || Atomics.load(poisonState, 0) !== 0) {
    throw new Error("Windows job Worker epoch is terminal.");
  }
  if (controllerReady) return controllerReady.promise;
  let resolveReady;
  let rejectReady;
  const promise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  controllerReady = { promise, resolve: resolveReady, reject: rejectReady };
  controllerError = "";
  const child = spawn(
    "pwsh.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      workerData.controllerScript,
      process.execPath,
      workerData.shimScript
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false
    }
  );
  controller = child;
  child.unref();
  child.stdout.on("data", consumeFrames);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (controllerError.length < 64 * 1024) {
      controllerError += chunk.slice(0, 64 * 1024 - controllerError.length);
    }
  });
  child.once("error", (error) => {
    if (controller !== child) return;
    controllerReady?.reject(error);
    recordControllerExit(child, error);
  });
  child.once("exit", () => {
    if (controller !== child) return;
    const error = new Error(
      `Windows job controller exited without terminal proof${controllerError ? `: ${controllerError}` : ""}`
    );
    controllerReady?.reject(error);
    recordControllerExit(child, error);
    Atomics.store(poisonState, 0, 3);
    Atomics.notify(poisonState, 0);
  });
  const startupTimer = setTimeout(() => {
    if (controller !== child) return;
    const error = new Error("Windows job controller startup/framing deadline expired.");
    controllerReady?.reject(error);
    markControllerPoisoned(error);
  }, 7000);
  promise.then(
    () => clearTimeout(startupTimer),
    () => clearTimeout(startupTimer)
  );
  return promise;
}

async function ensureController() {
  if (terminal || Atomics.load(poisonState, 0) !== 0) {
    throw new Error("Windows job Worker epoch is terminal.");
  }
  if (controller && controllerInstanceId) return;
  await startController();
}

async function request(type, payload, timeoutMs, { maxBuffer = 0 } = {}) {
  const requestId = nextRequestId++;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      const error = new Error(`Controller ${type} request deadline expired.`);
      markControllerPoisoned(error);
      reject(error);
    }, timeoutMs);
    pending.set(requestId, {
      resolve,
      reject,
      timer,
      type,
      maxBuffer,
      ownership: payload.ownership ?? payload.launch?.ownership,
      output: { stdout: [], stderr: [], total: 0 }
    });
  });
  try {
    await writeFrame({
      type,
      requestId,
      controllerInstanceId,
      ...payload
    });
  } catch (error) {
    const waiter = pending.get(requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(requestId);
      waiter.reject(error);
    }
  }
  return response;
}

async function cleanupLease(lease, timeoutMs = 7000) {
  await ensureController();
  if (lease.controllerInstanceId !== controllerInstanceId) {
    throw new Error("Controller instance changed before terminal cleanup proof.");
  }
  const response = await request("cleanup", {
    launchId: lease.launchId,
    ownership: lease.ownership
  }, timeoutMs);
  validateTerminalProof(response.result, lease);
  return response.result;
}

function validateLaunchResponse(response, expectedOwnership) {
  const successful = Number.isSafeInteger(response.pid) && response.pid > 0 &&
    response.spawnError === null;
  const failed = response.pid === null && response.spawnError &&
    typeof response.spawnError === "object" &&
    typeof response.spawnError.message === "string" &&
    typeof response.spawnError.code === "string" &&
    typeof response.spawnError.path === "string" &&
    Array.isArray(response.spawnError.spawnargs);
  if (typeof response.launchId !== "string" || !response.launchId ||
      (!successful && !failed) ||
      !sameOwnership(
        validateOwnership(response.ownership),
        validateOwnership(expectedOwnership)
      ) ||
      response.controllerInstanceId !== controllerInstanceId) {
    throw new Error("Controller returned an invalid launch response.");
  }
}

function validateWaitResult(result, expectedOwnership) {
  if (!result || typeof result !== "object" ||
      !sameOwnership(result, validateOwnership(expectedOwnership)) ||
      !(result.status === null || Number.isInteger(result.status)) ||
      typeof result.stdoutBase64 !== "string" ||
      typeof result.stderrBase64 !== "string" ||
      !(result.error === null || typeof result.error === "object")) {
    throw new Error("Controller returned an invalid wait result.");
  }
}

function validateTerminalProof(proof, lease) {
  if (!proof || typeof proof !== "object" ||
      !sameOwnership(proof, validateOwnership(lease.ownership)) ||
      proof.launchId !== lease.launchId ||
      proof.controllerInstanceId !== lease.controllerInstanceId ||
      !Number.isSafeInteger(proof.controllerPid) || proof.controllerPid <= 0 ||
      proof.status !== "stopped" ||
      proof.activeProcesses !== 0 ||
      proof.tombstone !== true) {
    throw new Error("Controller returned an invalid ownership terminal proof.");
  }
}

if (!workerData.requestPort) {
  throw new Error("The Windows job Worker requires a dedicated request port.");
}
requestPort = workerData.requestPort;
requestPort.on("message", async ({ operation, payload, port, shared }) => {
  const stages = new Int32Array(shared);
  Atomics.store(stages, 1, 1);
  try {
    if (operation === "shutdown") {
      await shutdownController();
      settlePort(port, shared, true);
      return;
    }
    await ensureController();
    Atomics.store(stages, 2, 1);
    if (operation === "launch") {
      const response = await request(
        "launch",
        { launch: payload.launch },
        payload.controlTimeout ?? 7000
      );
      validateLaunchResponse(response, payload.launch.ownership);
      Atomics.store(stages, 3, 1);
      if (payload.workerFault === "drop-response-port") {
        port.close();
        return;
      }
      settlePort(port, shared, {
        controllerInstanceId,
        controllerPid: controller.pid,
        launchId: response.launchId,
        ownership: response.ownership,
        pid: response.pid,
        spawnError: response.spawnError
      });
      return;
    }
    if (operation === "wait") {
      const lease = payload.lease;
      if (lease.controllerInstanceId !== controllerInstanceId) {
        throw new Error("Controller instance changed before wait.");
      }
      try {
        const response = await request(
          "wait",
          { launchId: lease.launchId, ownership: lease.ownership },
          payload.controlTimeout ?? 30000,
          { maxBuffer: lease.maxBuffer }
        );
        validateWaitResult(response.result, lease.ownership);
        if (payload.workerFault === "malformed-wait-value") {
          settlePort(port, shared, { status: "invalid" });
          return;
        }
        if (payload.workerFault === "noncanonical-wait-value") {
          settlePort(port, shared, {
            ...response.result,
            stdoutBase64: "AA"
          });
          return;
        }
        if (payload.workerFault === "oversized-wait-value") {
          settlePort(port, shared, {
            ...response.result,
            stdoutBase64: Buffer.alloc(lease.maxBuffer + 1).toString("base64")
          });
          return;
        }
        settlePort(port, shared, response.result);
      } catch (error) {
        try {
          await cleanupLease(lease);
        } catch (cleanupError) {
          error.message += `; cleanup proof missing: ${cleanupError.message}`;
        }
        throw error;
      }
      return;
    }
    if (operation === "cleanup") {
      if (payload.concurrent) {
        const [first, second] = await Promise.all([
          cleanupLease(payload.lease, payload.controlTimeout ?? 7000),
          cleanupLease(payload.lease, payload.controlTimeout ?? 7000)
        ]);
        if (JSON.stringify(first) !== JSON.stringify(second)) {
          throw new Error("Concurrent cleanup did not replay identical terminal proof.");
        }
        settlePort(port, shared, first);
        return;
      }
      settlePort(
        port,
        shared,
        await cleanupLease(payload.lease, payload.controlTimeout ?? 7000)
      );
      return;
    }
    throw new Error(`Unsupported controller operation: ${operation}`);
  } catch (error) {
    settlePort(port, shared, null, error);
  }
});

if (workerData.readySignal) {
  const ready = new Int32Array(workerData.readySignal);
  Atomics.store(ready, 0, 1);
  Atomics.notify(ready, 0);
}
