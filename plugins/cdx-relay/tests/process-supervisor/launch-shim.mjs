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
await new Promise((resolve, reject) => {
  let pending = "";
  socket.once("error", reject);
  socket.on("data", (chunk) => {
    pending += chunk;
    const newline = pending.indexOf("\n");
    if (newline < 0) return;
    const message = JSON.parse(pending.slice(0, newline));
    if (message.type !== "release" || message.version !== 1) {
      reject(new Error("Invalid supervisor release."));
      return;
    }
    socket.off("error", reject);
    resolve();
  });
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

const child = spawn(target.command, target.args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"]
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const [status, signal, rootError] = await new Promise((resolve) => {
  child.once("error", (error) => resolve([
    null,
    null,
    { name: error.name, code: error.code, message: error.message }
  ]));
  child.once("exit", (exitStatus, exitSignal) =>
    resolve([exitStatus, exitSignal, undefined]));
});
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
