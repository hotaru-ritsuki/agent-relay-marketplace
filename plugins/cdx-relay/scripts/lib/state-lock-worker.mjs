import { workerData } from "node:worker_threads";

import properLockfile from "proper-lockfile";

const STATUS_STARTING = 0;
const STATUS_ACQUIRED = 1;
const STATUS_RELEASED = 2;
const STATUS_FAILED = 3;
const STATUS_COMPROMISED = 4;

const port = workerData.port;
const signal = new Int32Array(workerData.signalBuffer);
const stateDir = workerData.stateDir;
const policy = workerData.policy;

let compromisedError = null;

function serializeError(error, fallbackCode) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code ?? fallbackCode,
    stack: error?.stack ?? null
  };
}

function send(message, status) {
  Atomics.store(signal, 1, status);
  port.postMessage(message);
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function acquire() {
  const deadline = Date.now() + policy.retryTimeoutMs;
  for (;;) {
    try {
      return await properLockfile.lock(stateDir, {
        realpath: false,
        retries: 0,
        stale: policy.stale,
        update: policy.update,
        onCompromised(error) {
          if (compromisedError) {
            return;
          }
          compromisedError = error;
          send(
            {
              type: "compromised",
              error: serializeError(error, "ECOMPROMISED")
            },
            STATUS_COMPROMISED
          );
        }
      });
    } catch (error) {
      if (error?.code !== "ELOCKED" || Date.now() >= deadline) {
        throw error;
      }
      await wait(Math.min(policy.retryDelayMs, Math.max(deadline - Date.now(), 0)));
    }
  }
}

function waitForReleaseRequest() {
  return new Promise((resolve, reject) => {
    port.once("message", (message) => {
      if (message?.type === "release") {
        resolve();
        return;
      }
      reject(Object.assign(new Error("Invalid state lock worker command."), {
        code: "ERR_STATE_LOCK_WORKER_PROTOCOL"
      }));
    });
    port.once("close", () => {
      reject(Object.assign(new Error("State lock owner closed before release."), {
        code: "ERR_STATE_LOCK_WORKER_EXIT"
      }));
    });
  });
}

async function main() {
  Atomics.store(signal, 1, STATUS_STARTING);
  const release = await acquire();
  send({ type: "acquired" }, STATUS_ACQUIRED);
  await waitForReleaseRequest();
  if (compromisedError) {
    throw compromisedError;
  }
  await release();
  send({ type: "released" }, STATUS_RELEASED);
}

main()
  .catch((error) => {
    if (!compromisedError) {
      send(
        {
          type: "error",
          error: serializeError(error, "ERR_STATE_LOCK_WORKER")
        },
        STATUS_FAILED
      );
    }
  })
  .finally(() => {
    port.close();
  });
