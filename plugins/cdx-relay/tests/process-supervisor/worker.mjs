import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

import { createProcessSupervisor } from "./coordinator.mjs";
import { SupervisorInfrastructureError } from "./errors.mjs";
import { MAX_FRAME_BYTES } from "./protocol.mjs";

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

function atomicWriteResult(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), {
    encoding: "utf8",
    mode: 0o600
  });
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

function deserializeResult(value) {
  if (value?.stdout?.type === "Buffer") {
    value.stdout = Buffer.from(value.stdout.data);
  }
  if (value?.stderr?.type === "Buffer") {
    value.stderr = Buffer.from(value.stderr.data);
  }
  return value;
}

export function runSynchronous(_runAsync, spec) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "process-supervisor-"));
  const requestFile = path.join(directory, "request.json");
  const resultFile = path.join(directory, "result.json");
  const signalBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const signal = new Int32Array(signalBuffer);
  try {
    const request = {
      ...spec,
      input: spec.input === undefined
        ? undefined
        : Buffer.from(spec.input).toString("base64")
    };
    fs.writeFileSync(requestFile, JSON.stringify(request), {
      encoding: "utf8",
      mode: 0o600
    });
    const worker = new Worker(new URL(import.meta.url), { execArgv: [] });
    worker.postMessage({ requestFile, resultFile, signalBuffer });
    const bridgeTimeout = Number.isSafeInteger(spec.controlTimeout)
      ? spec.controlTimeout
      : 600_000;
    const wait = Atomics.wait(signal, 0, 0, bridgeTimeout);
    if (Atomics.load(signal, 0) !== 1) {
      throw new SupervisorInfrastructureError(
        "SYNC_BRIDGE_FAILED",
        `The synchronous supervisor Worker did not signal within ${bridgeTimeout}ms.`
      );
    }
    const response = boundedJson(resultFile);
    if (!response.ok) {
      throw new SupervisorInfrastructureError(
        response.error?.code ?? "SUPERVISOR_FAILURE",
        response.error?.message ?? "The synchronous supervisor Worker failed.",
        { result: response.error?.result }
      );
    }
    return deserializeResult(response.result);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (!isMainThread) {
  parentPort.on("message", async ({ requestFile, resultFile, signalBuffer }) => {
    const signal = new Int32Array(signalBuffer);
    try {
      const request = boundedJson(requestFile);
      if (request.input !== undefined) {
        request.input = Buffer.from(request.input, "base64");
      }
      const supervisor = createProcessSupervisor();
      const result = await supervisor.runAsync(request);
      atomicWriteResult(resultFile, { ok: true, result });
    } catch (error) {
      atomicWriteResult(resultFile, {
        ok: false,
        error: serializeError(error)
      });
    } finally {
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    }
  });
}
