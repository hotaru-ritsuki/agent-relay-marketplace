import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const request = JSON.parse(fs.readFileSync(0, "utf8"));
const handshakeFile = process.argv[2];

function serializeSpawnError(error) {
  return {
    message: String(error?.message ?? "target spawn failed"),
    code: String(error?.code ?? "UNKNOWN"),
    errno: Number.isInteger(error?.errno) ? error.errno : null,
    syscall: typeof error?.syscall === "string" ? error.syscall : null,
    path: typeof error?.path === "string" ? error.path : request.command,
    spawnargs: Array.isArray(error?.spawnargs) ? error.spawnargs : request.args
  };
}

function publishHandshake(value) {
  if (request.testFault === "pid-handshake-sharing-lock") {
    const descriptor = fs.openSync(handshakeFile, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    } finally {
      fs.closeSync(descriptor);
    }
    return;
  }
  const temporaryFile = `${handshakeFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryFile, handshakeFile);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporaryFile); } catch {}
    throw error;
  }
}

if (request.testFault === "pid-handshake-early-exit") {
  process.exit(125);
}
if (request.testFault === "pid-handshake-timeout") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
}

let child;
try {
  child = spawn(request.command, request.args, {
    cwd: request.options.cwd,
    env: request.options.env,
    shell: request.options.shell,
    detached: request.options.detached,
    windowsHide: request.options.windowsHide,
    stdio: ["pipe", "inherit", "inherit"]
  });
} catch (error) {
  publishHandshake({ error: serializeSpawnError(error) });
  process.exit(127);
}
if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
  const error = await new Promise((resolve) => child.once("error", resolve));
  publishHandshake({ error: serializeSpawnError(error) });
  process.exit(127);
}
const publishedPid = request.testFault === "pid-handshake-wrong-pid"
  ? process.pid
  : request.testFault === "pid-handshake-nonmember-pid"
    ? request.handshakePid
    : child.pid;
if (request.testFault === "pid-handshake-malformed") {
  fs.writeFileSync(handshakeFile, "{ malformed", { flag: "wx", mode: 0o600 });
} else {
publishHandshake({ pid: publishedPid, parentPid: process.pid });
}

const input = request.input?.type === "base64"
  ? Buffer.from(request.input.value, "base64")
  : request.input?.value ?? "";
child.stdin.end(input);

const result = await new Promise((resolve) => {
  child.once("error", () => resolve(127));
  child.once("exit", (status) => resolve(Number.isInteger(status) ? status : 1));
});
process.exit(result);
