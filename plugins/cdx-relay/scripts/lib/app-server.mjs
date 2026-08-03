/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
const DEFAULT_RPC_DEADLINE_MS = 30_000;
const MAX_JSONL_MESSAGE_CHARS = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_PROTOCOL_PREVIEW_CHARS = 4096;

export function deadlineForMethod(_method) {
  return DEFAULT_RPC_DEADLINE_MS;
}

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

function createTransportWriteError(error) {
  return new Error("codex app-server transport write failed.", { cause: error });
}

function boundedProtocolPreview(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_PROTOCOL_PREVIEW_CHARS) {
    return text;
  }
  const half = Math.floor(MAX_PROTOCOL_PREVIEW_CHARS / 2);
  return `${text.slice(0, half)}...[truncated]...${text.slice(-half)}`;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.stderrTruncated = false;
    this.closed = false;
    this.exitError = null;
    this.terminalListeners = new Set();
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  addTerminalListener(listener) {
    if (this.closed) {
      listener(this.exitError ?? new Error("codex app-server connection closed."));
      return () => {};
    }

    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @param {{ timeoutMs?: number }} [requestOptions]
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params, requestOptions = {}) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timeoutMs = requestOptions.timeoutMs ?? deadlineForMethod(method);
      const pending = { resolve, reject, method, deadlineTimer: null };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.deadlineTimer = setTimeout(() => {
          const expired = this.takePending(id);
          if (expired) {
            expired.reject(new Error(`codex app-server ${method} timed out after ${timeoutMs} ms.`));
          }
        }, timeoutMs);
        pending.deadlineTimer.unref?.();
      }
      this.pending.set(id, pending);
      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        this.handleExit(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    try {
      this.sendMessage({ method, params });
    } catch (error) {
      this.handleExit(error);
    }
  }

  takePending(id) {
    const pending = this.pending.get(id);
    if (!pending) {
      return null;
    }
    this.pending.delete(id);
    if (pending.deadlineTimer) {
      clearTimeout(pending.deadlineTimer);
      pending.deadlineTimer = null;
    }
    return pending;
  }

  handleChunk(chunk) {
    if (this.closed) {
      return;
    }

    let offset = 0;
    while (offset < chunk.length && !this.closed) {
      const newlineIndex = chunk.indexOf("\n", offset);
      const segmentEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
      const segment = chunk.slice(offset, segmentEnd);
      if (this.lineBuffer.length + segment.length > MAX_JSONL_MESSAGE_CHARS) {
        this.lineBuffer = "";
        this.handleExit(
          createProtocolError(
            `codex app-server JSONL message exceeded ${MAX_JSONL_MESSAGE_CHARS} characters.`,
            { maxChars: MAX_JSONL_MESSAGE_CHARS }
          )
        );
        return;
      }
      this.lineBuffer += segment;
      if (newlineIndex === -1) {
        return;
      }
      const line = this.lineBuffer;
      this.lineBuffer = "";
      this.handleLine(line);
      offset = newlineIndex + 1;
    }
  }

  handleInputEnd() {
    if (this.closed || !this.lineBuffer) {
      return;
    }
    const line = this.lineBuffer;
    this.lineBuffer = "";
    this.handleLine(line);
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(
        createProtocolError(
          `Failed to parse codex app-server JSONL: ${error.message}`,
          { line: boundedProtocolPreview(line) }
        )
      );
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.takePending(message.id);
      if (!pending) {
        return;
      }

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    try {
      this.sendMessage({
        id: message.id,
        error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
      });
    } catch (error) {
      this.handleExit(error);
    }
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.closed = true;
    this.exitError = error instanceof Error ? error : new Error("codex app-server connection closed.");

    for (const id of [...this.pending.keys()]) {
      const pending = this.takePending(id);
      pending?.reject(this.exitError);
    }
    for (const listener of this.terminalListeners) {
      try {
        listener(this.exitError);
      } catch {
        // A terminal listener cannot prevent the remaining waiters from settling.
      }
    }
    this.terminalListeners.clear();
    this.resolveExit(undefined);
  }

  appendStderr(chunk) {
    if (this.closed) {
      return;
    }
    const text = String(chunk);
    if (this.stderr.length + text.length <= MAX_STDERR_CHARS) {
      this.stderr += text;
      return;
    }
    if (text.length >= MAX_STDERR_CHARS) {
      this.stderr = text.slice(-MAX_STDERR_CHARS);
    } else {
      this.stderr = `${this.stderr.slice(-(MAX_STDERR_CHARS - text.length))}${text}`;
    }
    this.stderrTruncated = true;
    const stderr = this.stderrForError();
    this.handleExit(
      createProtocolError(
        `codex app-server stderr exceeded ${MAX_STDERR_CHARS} characters.${stderr ? `\n${stderr}` : ""}`,
        { maxChars: MAX_STDERR_CHARS }
      )
    );
  }

  stderrForError() {
    const stderr = this.stderr.trim();
    if (!stderr) {
      return "";
    }
    return this.stderrTruncated
      ? `[stderr truncated to last ${MAX_STDERR_CHARS} characters]\n${stderr}`
      : stderr;
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });
    this.processClosePromise = new Promise((resolve) => {
      this.resolveProcessClose = resolve;
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.appendStderr(chunk);
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
      this.resolveProcessClose();
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderrForError();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.proc.on("close", (code, signal) => {
      const stderr = this.stderrForError();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server transport closed unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
      this.resolveProcessClose();
    });

    this.proc.stdin.on("error", (error) => {
      this.handleExit(createTransportWriteError(error));
    });

    this.proc.stdout.on("data", (chunk) => {
      this.handleChunk(chunk);
    });
    this.proc.stdout.on("end", () => {
      this.handleInputEnd();
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    }, { timeoutMs: this.options.initializeTimeoutMs });
    this.notify("initialized", {});
  }

  async close() {
    this.handleExit(new Error("codex app-server connection closed."));

    if (this.proc?.stdout && !this.proc.stdout.destroyed) {
      this.proc.stdout.destroy();
    }

    let killTimer = null;
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      if (!this.proc.stdin.destroyed) {
        try {
          this.proc.stdin.end();
        } catch (error) {
          this.handleExit(error);
        }
      }
      killTimer = setTimeout(() => {
        if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50);
      killTimer.unref?.();
    }

    await this.processClosePromise;
    if (killTimer) {
      clearTimeout(killTimer);
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    try {
      stdin.write(line, (error) => {
        if (error) {
          this.handleExit(createTransportWriteError(error));
        }
      });
    } catch (error) {
      throw createTransportWriteError(error);
    }
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socketClosePromise = new Promise((resolveClose) => {
        this.resolveSocketClose = resolveClose;
      });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
        this.resolveSocketClose();
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    }, { timeoutMs: this.options.initializeTimeoutMs });
    this.notify("initialized", {});
  }

  async close() {
    this.handleExit(new Error("codex app-server connection closed."));
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    await (this.socketClosePromise ?? this.exitPromise);
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    try {
      socket.write(line, (error) => {
        if (error) {
          this.handleExit(createTransportWriteError(error));
        }
      });
    } catch (error) {
      throw createTransportWriteError(error);
    }
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        const storedBroker = loadBrokerSession(cwd);
        brokerEndpoint = storedBroker?.state === "ready" ? storedBroker.endpoint ?? null : null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
}
