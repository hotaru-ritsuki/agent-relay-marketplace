#!/usr/bin/env node

import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";

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
    parentPid: process.ppid
  })}\n`);
});
socket.on("error", () => {});

const child = spawn(target.command, target.args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"]
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let escalationTimer;
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
      escalationTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    }
    return;
  }
})().catch((error) => socket.destroy(error));

const [status, signal, rootError] = await new Promise((resolve) => {
  child.once("error", (error) => resolve([
    null,
    null,
    { name: error.name, code: error.code, message: error.message }
  ]));
  child.once("exit", (exitStatus, exitSignal) =>
    resolve([exitStatus, exitSignal, undefined]));
});
clearTimeout(escalationTimer);
await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.write(`${JSON.stringify({
    type: "root",
    version: 1,
    epoch: token.epoch,
    runId: token.runId,
    nonce: token.nonce,
    backend: "posix-cooperative",
    status,
    signal,
    error: rootError
  })}\n`, resolve);
});
socket.end();
process.exitCode = status ?? (signal ? 1 : 0);
