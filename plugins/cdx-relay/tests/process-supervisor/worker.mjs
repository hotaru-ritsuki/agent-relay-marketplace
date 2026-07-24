import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

import { SupervisorInfrastructureError } from "./errors.mjs";
import { MAX_FRAME_BYTES, serializeBounded } from "./protocol.mjs";

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
    maxBuffer: spec.maxBuffer ?? MAX_FRAME_BYTES,
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

export function runSynchronous(request) {
  const requestJson = serializeBounded(request);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "process-supervisor-"));
  const requestFile = path.join(directory, "request.json");
  const resultFile = path.join(directory, "result.json");
  const signalBuffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * 3
  );
  const signal = new Int32Array(signalBuffer);
  let worker;
  try {
    fs.writeFileSync(requestFile, requestJson, {
      encoding: "utf8",
      mode: 0o600
    });
    worker = new Worker(new URL(import.meta.url), { execArgv: [] });
    worker.unref();
    worker.postMessage({ requestFile, resultFile, signalBuffer });
    const operationTimeout = Number.isSafeInteger(request.spec?.timeout)
      ? request.spec.timeout + 5_000
      : 600_000;
    Atomics.wait(signal, 0, 0, operationTimeout);
    if (Atomics.load(signal, 0) !== 1) {
      throw new SupervisorInfrastructureError(
        "SYNC_BRIDGE_FAILED",
        `The synchronous supervisor Worker did not finish within ${operationTimeout}ms.`
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
    if (worker) {
      Atomics.store(signal, 1, 1);
      Atomics.notify(signal, 1);
      Atomics.wait(signal, 2, 0, 5_000);
      if (Atomics.load(signal, 2) !== 1) {
        void worker.terminate();
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (!isMainThread) {
  let exitSignal;
  process.once("exit", () => {
    if (exitSignal) {
      Atomics.store(exitSignal, 2, 1);
      Atomics.notify(exitSignal, 2);
    }
  });
  parentPort.on("message", ({ requestFile, resultFile, signalBuffer }) => {
    exitSignal = new Int32Array(signalBuffer);
    try {
      const request = boundedJson(requestFile);
      const result = executeChildProcess(request);
      atomicWriteBounded(resultFile, { ok: true, result });
    } catch (error) {
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
    } finally {
      Atomics.store(exitSignal, 0, 1);
      Atomics.notify(exitSignal, 0);
      Atomics.wait(exitSignal, 1, 0);
      parentPort.close();
    }
  });
}
