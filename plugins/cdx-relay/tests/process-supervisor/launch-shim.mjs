#!/usr/bin/env node

import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const token = JSON.parse(
  Buffer.from(process.env.CDX_RELAY_SUPERVISOR_TOKEN ?? "", "base64url")
    .toString("utf8")
);
if (!token || token.version !== 1 ||
    ["epoch", "runId", "nonce", "endpoint"].some(
      (field) => typeof token[field] !== "string" || !token[field]
    )) {
  throw new Error("Invalid CDX_RELAY_SUPERVISOR_TOKEN.");
}
if (!token.endpoint.startsWith("unix:")) {
  throw new Error("The POSIX launch shim requires a Unix registration socket.");
}
const rootCredential = process.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL;
if (typeof rootCredential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(rootCredential)) {
  throw new Error("Invalid CDX_RELAY_ROOT_REPORT_CREDENTIAL.");
}
delete process.env.CDX_RELAY_ROOT_REPORT_CREDENTIAL;
const target = JSON.parse(
  Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8")
);
if (typeof target.command !== "string" || !target.command ||
    !Array.isArray(target.args) ||
    target.args.some((argument) => typeof argument !== "string")) {
  throw new Error("Invalid POSIX launch target.");
}

const socket = net.createConnection({ path: token.endpoint.slice("unix:".length) });
socket.setEncoding("utf8");
let pending = "";
const frames = [];
let resolveFrame;
const nextFrame = () => frames.length > 0
  ? Promise.resolve(frames.shift())
  : new Promise((resolve) => {
      resolveFrame = resolve;
    });
socket.on("data", (chunk) => {
  pending += chunk;
  if (Buffer.byteLength(pending) > 1024 * 1024) {
    socket.destroy(new Error("Supervisor frame exceeds 1048576 bytes."));
    return;
  }
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const raw = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    const frame = JSON.parse(raw);
    if (resolveFrame) {
      const resolve = resolveFrame;
      resolveFrame = undefined;
      resolve(frame);
    } else {
      frames.push(frame);
    }
  }
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error("Supervisor release deadline expired."));
  }, 5000);
  socket.once("error", reject);
  nextFrame().then((message) => {
    if (message.type !== "release" || message.version !== 1) {
      clearTimeout(timer);
      reject(new Error("Invalid supervisor release."));
      return;
    }
    socket.off("error", reject);
    clearTimeout(timer);
    resolve();
  }, reject);
  socket.write(`${JSON.stringify({
    type: "hello",
    version: 1,
    epoch: token.epoch,
    runId: token.runId,
    nonce: token.nonce,
    backend: "posix-cooperative",
    pid: process.pid,
    parentPid: process.ppid,
    rootCredential
  })}\n`);
});
socket.on("error", () => {});

const child = spawn(target.command, target.args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"]
});
const describeError = (error) => ({
  name: String(error?.name ?? "Error").slice(0, 128),
  code: String(error?.code ?? "STDIN_FORWARDING_FAILED").slice(0, 128),
  message: String(error?.message ?? error ?? "stdin forwarding failed")
    .slice(0, 4096)
});
let stdinEscalationTimer;
let stopEscalationTimer;
let stdinBytesForwarded = 0;
const countForwardedStdin = new Transform({
  transform(chunk, encoding, callback) {
    stdinBytesForwarded += chunk.length;
    callback(null, chunk);
  }
});
const stdinForwarding = pipeline(
  process.stdin,
  countForwardedStdin,
  child.stdin
).then(
  () => undefined,
  (error) => {
    if (stdinBytesForwarded === 0 &&
        ["EPIPE", "EOF", "ERR_STREAM_PREMATURE_CLOSE"].includes(error?.code)) {
      return undefined;
    }
    child.kill("SIGTERM");
    stdinEscalationTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    return describeError(error);
  }
);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
void (async () => {
  for (;;) {
    const message = await nextFrame();
    if (message.type !== "stop" ||
        message.version !== 1 ||
        message.epoch !== token.epoch ||
        message.runId !== token.runId ||
        message.nonce !== token.nonce ||
        message.backend !== "posix-cooperative" ||
        typeof message.signal !== "string" ||
        !message.signal) {
      throw new Error("Invalid authenticated supervisor stop frame.");
    }
    child.kill(message.signal);
    if (message.signal !== "SIGKILL") {
      stopEscalationTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    }
    return;
  }
})().catch((error) => socket.destroy(error));

const childTerminal = new Promise((resolve) => {
  child.once("error", (error) => resolve([
    null,
    null,
    describeError(error)
  ]));
  child.once("exit", (exitStatus, exitSignal) =>
    resolve([exitStatus, exitSignal, undefined]));
});
const [[childStatus, childSignal, childError], stdinError] = await Promise.all([
  childTerminal,
  stdinForwarding
]);
const rootError = childError ?? stdinError;
const status = rootError ? null : childStatus;
const signal = rootError ? null : childSignal;
clearTimeout(stdinEscalationTimer);
clearTimeout(stopEscalationTimer);
await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.write(`${JSON.stringify({
    type: "root",
    version: 1,
    epoch: token.epoch,
    runId: token.runId,
    nonce: token.nonce,
    backend: "posix-cooperative",
    rootCredential,
    status,
    signal,
    error: rootError
  })}\n`, resolve);
});
socket.end();
process.exitCode = rootError ? 1 : status ?? (signal ? 1 : 0);
