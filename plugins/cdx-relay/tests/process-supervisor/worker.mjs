import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData
} from "node:worker_threads";

import { SupervisorInfrastructureError } from "./errors.mjs";
import { MAX_FRAME_BYTES, serializeBounded } from "./protocol.mjs";

const WORKER_EXIT_TIMEOUT = 5_000;

function boundedJson(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FRAME_BYTES) {
    throw new SupervisorInfrastructureError(
      "PROTOCOL_FRAME_TOO_LARGE",
      `Bridge file exceeds ${MAX_FRAME_BYTES} bytes.`
    );
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function atomicWriteBounded(filePath, value) {
  const json = serializeBounded(value);
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, json, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message,
    result: error?.result
  };
}

function writeErrorResult(resultFile, error) {
  try {
    atomicWriteBounded(resultFile, {
      ok: false,
      error: serializeError(error)
    });
  } catch (writeError) {
    atomicWriteBounded(resultFile, {
      ok: false,
      error: serializeError(new SupervisorInfrastructureError(
        "PROTOCOL_FRAME_TOO_LARGE",
        writeError.message
      ))
    });
  }
}

function decodeBuffers(value) {
  if (!value || typeof value !== "object") return value;
  for (const [key, item] of Object.entries(value)) {
    if (item?.type === "Buffer" && typeof item.data === "string") {
      value[key] = Buffer.from(item.data, "base64");
    } else {
      decodeBuffers(item);
    }
  }
  return value;
}

function executeChildProcess(request) {
  if (request.backendSelection?.type !== "child-process") {
    throw new SupervisorInfrastructureError(
      "BACKEND_SELECTION_INVALID",
      "The synchronous backend selection is not supported."
    );
  }
  const spec = request.spec;
  if (spec.shell !== false) {
    throw new SupervisorInfrastructureError(
      "SHELL_UNSAFE",
      "The synchronous Worker requires shell: false."
    );
  }
  const result = spawnSync(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    input: spec.input,
    encoding: spec.encoding ?? "utf8",
    timeout: spec.timeout,
    maxBuffer: Math.min(spec.maxBuffer ?? MAX_FRAME_BYTES, MAX_FRAME_BYTES),
    shell: false,
    windowsHide: true,
    stdio: spec.stdio
  });
  return {
    capabilities: {
      platform: request.platform,
      backend: "child-process",
      mode: "cooperative",
      containment: "cooperative",
      cleanupProof: "registered-drained",
      supportsDetachedDescendants: false
    },
    root: {
      backend: "child-process",
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ? serializeError(result.error) : undefined
    },
    cleanup: {
      backend: "child-process",
      level: "registered-drained"
    }
  };
}

function operationTimeoutFor(request, override) {
  if (Number.isSafeInteger(override) && override > 0) return override;
  return Number.isSafeInteger(request.spec?.timeout)
    ? request.spec.timeout + 5_000
    : 600_000;
}

export function runSynchronous(request, {
  operationTimeout,
  executorUrl = new URL(import.meta.url),
  lifecycleBuffer
} = {}) {
  const requestJson = serializeBounded(request);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "process-supervisor-"));
  const requestFile = path.join(directory, "request.json");
  const resultFile = path.join(directory, "result.json");
  const signalBuffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * 3
  );
  const signal = new Int32Array(signalBuffer);
  const boundedTimeout = operationTimeoutFor(request, operationTimeout);
  let controller;
  try {
    fs.writeFileSync(requestFile, requestJson, {
      encoding: "utf8",
      mode: 0o600
    });
    controller = new Worker(new URL(import.meta.url), {
      execArgv: [],
      workerData: {
        role: "controller",
        requestFile,
        resultFile,
        signalBuffer,
        lifecycleBuffer,
        operationTimeout: boundedTimeout,
        executorUrl: String(executorUrl)
      }
    });
    controller.unref();
    Atomics.wait(
      signal,
      0,
      0,
      boundedTimeout + WORKER_EXIT_TIMEOUT
    );
    if (Atomics.load(signal, 0) !== 1) {
      throw new SupervisorInfrastructureError(
        "SYNC_BRIDGE_FAILED",
        `The synchronous supervisor controller did not finish within ${boundedTimeout + WORKER_EXIT_TIMEOUT}ms.`
      );
    }
    const response = decodeBuffers(boundedJson(resultFile));
    if (!response.ok) {
      const code = response.error?.code ?? "SUPERVISOR_FAILURE";
      const rawMessage = response.error?.message ??
        "The synchronous supervisor Worker failed.";
      const message = rawMessage.startsWith(`${code}: `)
        ? rawMessage.slice(code.length + 2)
        : rawMessage;
      throw new SupervisorInfrastructureError(code, message, {
        result: response.error?.result
      });
    }
    return response.result;
  } finally {
    if (controller) {
      Atomics.store(signal, 1, 1);
      Atomics.notify(signal, 1);
      Atomics.wait(signal, 2, 0, WORKER_EXIT_TIMEOUT);
      if (Atomics.load(signal, 2) !== 1) {
        throw new SupervisorInfrastructureError(
          "SYNC_BRIDGE_FAILED",
          "The synchronous supervisor controller did not confirm cleanup."
        );
      }
    } else {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

async function runController() {
  const {
    requestFile,
    resultFile,
    signalBuffer,
    lifecycleBuffer,
    operationTimeout,
    executorUrl
  } = workerData;
  const signal = new Int32Array(signalBuffer);
  const lifecycle = lifecycleBuffer
    ? new Int32Array(lifecycleBuffer)
    : undefined;
  const recordLifecycle = (index) => {
    if (lifecycle) {
      Atomics.store(lifecycle, index, Atomics.add(lifecycle, 2, 1) + 1);
    }
  };
  let executor;
  try {
    executor = new Worker(new URL(executorUrl), {
      execArgv: [],
      workerData: {
        role: "executor",
        requestFile,
        resultFile
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SupervisorInfrastructureError(
          "SYNC_BRIDGE_FAILED",
          `The synchronous supervisor Worker did not finish within ${operationTimeout}ms.`
        ));
      }, operationTimeout);
      executor.once("message", (message) => {
        if (message !== "done") return;
        clearTimeout(timer);
        resolve();
      });
      executor.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      executor.once("exit", (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          reject(new SupervisorInfrastructureError(
            "SYNC_BRIDGE_FAILED",
            `The synchronous supervisor Worker exited with code ${code}.`
          ));
        }
      });
    });
    await executor.terminate();
    recordLifecycle(0);
  } catch (error) {
    if (executor) {
      await executor.terminate();
      recordLifecycle(0);
    }
    writeErrorResult(resultFile, error);
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    Atomics.wait(signal, 1, 0);
    fs.rmSync(path.dirname(requestFile), { recursive: true, force: true });
    recordLifecycle(1);
    Atomics.store(signal, 2, 1);
    Atomics.notify(signal, 2);
    parentPort.close();
  }
}

function runExecutor() {
  try {
    const request = decodeBuffers(boundedJson(workerData.requestFile));
    const result = executeChildProcess(request);
    atomicWriteBounded(workerData.resultFile, { ok: true, result });
  } catch (error) {
    writeErrorResult(workerData.resultFile, error);
  } finally {
    parentPort.postMessage("done");
    parentPort.close();
  }
}

if (!isMainThread) {
  if (workerData?.role === "controller") {
    void runController();
  } else if (workerData?.role === "executor") {
    runExecutor();
  }
}
