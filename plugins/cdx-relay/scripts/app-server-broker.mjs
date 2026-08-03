#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import {
  BROKER_AUTH_ERROR_CODE,
  markBrokerSessionFailed,
  recordAppServerOwnership
} from "./lib/broker-lifecycle.mjs";
import { captureProcessIdentity } from "./lib/process-identity.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const MAX_BROKER_REQUEST_CHARS = 8 * 1024 * 1024;
const BROKER_SERVER_CLOSE_TIMEOUT_MS = 500;
let emergencyFailureHandler = null;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile, pid = process.pid) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> --nonce <value> [--cwd <path>] [--pid-file <path>]");
  }
  if (process.env.CDX_RELAY_SUPERVISOR_TOKEN) {
    const { registerControlledDescendant } =
      await import("../tests/process-supervisor/coordinator.mjs");
    await registerControlledDescendant();
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "nonce"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }
  if (!options.nonce) {
    throw new Error("Missing required --nonce.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const nonce = String(options.nonce);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const sessionDir = pidFile ? path.dirname(pidFile) : null;
  writePidFile(pidFile);

  let appClient = null;
  let server = null;
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  let intentionalShutdown = false;
  let terminalizing = false;
  let shutdownPromise = null;

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  function removeRuntimeArtifacts() {
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  function beginServerClose() {
    if (!server?.listening) return null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        server.close(finish);
      } catch {
        finish();
      }
    });
  }

  function publishFailureBestEffort(error) {
    try {
      markBrokerSessionFailed(cwd, { endpoint, pid: process.pid, nonce }, error);
    } catch (publicationError) {
      process.stderr.write(
        `Failed to publish broker failure: ${publicationError instanceof Error ? publicationError.message : String(publicationError)}\n`
      );
    }
  }

  function beginShutdown({ intentional = false, error = null, destroySockets = true } = {}) {
    if (intentional) intentionalShutdown = true;
    terminalizing = true;
    if (shutdownPromise) return shutdownPromise;

    const serverClose = beginServerClose();
    for (const socket of sockets) {
      if (destroySockets) socket.destroy();
      else socket.end();
    }
    if (error) publishFailureBestEffort(error);

    shutdownPromise = (async () => {
      await appClient?.close().catch(() => {});
      for (const socket of sockets) socket.destroy();
      if (serverClose) {
        await Promise.race([
          serverClose,
          new Promise((resolve) => {
            const timer = setTimeout(resolve, BROKER_SERVER_CLOSE_TIMEOUT_MS);
            timer.unref?.();
          })
        ]);
      }
      removeRuntimeArtifacts();
    })();
    return shutdownPromise;
  }

  async function exitAfterShutdown({ intentional = false, error = null, exitCode = 1, destroySockets = true } = {}) {
    try {
      await beginShutdown({ intentional, error, destroySockets });
    } finally {
      process.exit(exitCode);
    }
  }

  emergencyFailureHandler = (error) => exitAfterShutdown({ error, exitCode: 1 });
  process.on("SIGTERM", () => {
    void exitAfterShutdown({ intentional: true, exitCode: 0, destroySockets: false });
  });
  process.on("SIGINT", () => {
    void exitAfterShutdown({ intentional: true, exitCode: 0, destroySockets: false });
  });

  try {
    appClient = await CodexAppServerClient.connect(cwd, {
      disableBroker: true,
      onClientCreated(client) {
        appClient = client;
      },
      onProcessSpawned(child) {
        if (!sessionDir || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
          throw new Error("The broker could not bind ownership to the spawned app-server process.");
        }
        const processIdentity = captureProcessIdentity(child.pid);
        if (!processIdentity) {
          throw new Error("The spawned app-server exited before its ownership identity could be captured.");
        }
        recordAppServerOwnership({
          sessionDir,
          endpoint,
          nonce,
          brokerPid: process.pid,
          childPid: child.pid,
          processIdentity
        });
      }
    });
  } catch (error) {
    if (terminalizing) {
      await shutdownPromise;
      return;
    }
    await exitAfterShutdown({ error, exitCode: 1 });
    return;
  }

  appClient.setNotificationHandler(routeNotification);

  server = net.createServer((socket) => {
    if (terminalizing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let inputRejected = false;

    socket.on("data", async (chunk) => {
      if (inputRejected || terminalizing) {
        socket.destroy();
        return;
      }
      if (buffer.length + chunk.length > MAX_BROKER_REQUEST_CHARS) {
        inputRejected = true;
        buffer = "";
        const diagnostic = `${JSON.stringify({
          id: null,
          error: buildJsonRpcError(-32600, "Broker request exceeded the maximum request size.")
        })}\n`;
        socket.end(diagnostic);
        const destroyTimer = setTimeout(() => socket.destroy(), 250);
        destroyTimer.unref?.();
        return;
      }
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/status") {
          if (message.params?.nonce !== nonce) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(BROKER_AUTH_ERROR_CODE, "Broker authentication failed.")
            });
            continue;
          }
          send(socket, {
            id: message.id,
            result: { state: "ready", pid: process.pid, nonce }
          });
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          if (message.params?.nonce !== nonce) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(BROKER_AUTH_ERROR_CODE, "Broker authentication failed.")
            });
            continue;
          }
          send(socket, { id: message.id, result: { stopped: true, nonce } });
          await exitAfterShutdown({ intentional: true, exitCode: 0, destroySockets: false });
          return;
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  appClient.addTerminalListener((error) => {
    if (intentionalShutdown || terminalizing) return;
    void exitAfterShutdown({ error, exitCode: 1, destroySockets: true });
  });

  server.on("error", (error) => {
    if (terminalizing) return;
    void exitAfterShutdown({ error, exitCode: 1, destroySockets: true });
  });
  if (!terminalizing) {
    try {
      server.listen(listenTarget.path);
    } catch (error) {
      await exitAfterShutdown({ error, exitCode: 1, destroySockets: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (emergencyFailureHandler) {
    void emergencyFailureHandler(error);
    return;
  }
  process.exit(1);
});
