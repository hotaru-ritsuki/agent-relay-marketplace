import { workerData } from "node:worker_threads";

if (workerData?.role === "executor") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
