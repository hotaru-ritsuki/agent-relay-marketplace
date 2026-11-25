import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../scripts/lib/broker-endpoint.mjs";
import {
  captureProcessIdentity,
  matchesProcessIdentity
} from "../scripts/lib/process-identity.mjs";

test("createBrokerEndpoint uses the host-native path for Unix sockets", () => {
  const endpoint = createBrokerEndpoint("/tmp/cxc-12345", "darwin");
  const socketPath = path.join("/tmp/cxc-12345", "broker.sock");
  assert.equal(endpoint, `unix:${socketPath}`);
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "unix",
    path: socketPath
  });
});

test("createBrokerEndpoint uses named pipes on Windows", () => {
  const endpoint = createBrokerEndpoint("C:\\\\Temp\\\\cxc-12345", "win32");
  assert.equal(endpoint, "pipe:\\\\.\\pipe\\cxc-12345-codex-app-server");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "pipe",
    path: "\\\\.\\pipe\\cxc-12345-codex-app-server"
  });
});

test("captureProcessIdentity parses Linux stat field 22 and the executable link", () => {
  const identity = captureProcessIdentity(4321, {
    platform: "linux",
    readFileSync(filePath) {
      assert.equal(filePath, "/proc/4321/stat");
      return "4321 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20\n";
    },
    readlinkSync(filePath) {
      assert.equal(filePath, "/proc/4321/exe");
      return "/usr/bin/node";
    }
  });

  assert.deepEqual(identity, {
    pid: 4321,
    startIdentity: "987654",
    executableIdentity: "/usr/bin/node"
  });
});

test("captureProcessIdentity invokes macOS ps with an argument array and parses its command", () => {
  let invocation = null;
  const identity = captureProcessIdentity(4321, {
    platform: "darwin",
    runCommandImpl(command, args, options) {
      invocation = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "Mon Aug  3 17:24:09 2026 /usr/local/bin/node broker.mjs --serve\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.deepEqual(invocation, {
    command: "ps",
    args: ["-o", "lstart=", "-o", "command=", "-p", "4321"],
    options: { shell: false }
  });
  assert.deepEqual(identity, {
    pid: 4321,
    startIdentity: "Mon Aug  3 17:24:09 2026",
    executableIdentity: "/usr/local/bin/node broker.mjs --serve"
  });
});

test("captureProcessIdentity uses noninteractive Windows CIM without wmic", () => {
  let invocation = null;
  const identity = captureProcessIdentity(4321, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    runCommandImpl(command, args, options) {
      invocation = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          ProcessId: 4321,
          CreationDate: "20260803172409.123456+180",
          ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
          CommandLine: "node.exe broker.mjs serve"
        }),
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["-NoLogo", "-NoProfile", "-NonInteractive"]);
  assert.equal(invocation.args[3], "-Command");
  assert.match(invocation.args[4], /Get-CimInstance Win32_Process/);
  assert.doesNotMatch(`${invocation.command} ${invocation.args.join(" ")}`, /wmic/i);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(identity, {
    pid: 4321,
    startIdentity: "20260803172409.123456+180",
    executableIdentity: "C:\\Program Files\\nodejs\\node.exe\nnode.exe broker.mjs serve"
  });
});

test("matchesProcessIdentity requires pid, start, and executable identity", () => {
  const expected = {
    pid: 4321,
    startIdentity: "987654",
    executableIdentity: "/usr/bin/node"
  };

  assert.equal(matchesProcessIdentity(expected, { ...expected }), true);
  assert.equal(matchesProcessIdentity(expected, { ...expected, pid: 4322 }), false);
  assert.equal(matchesProcessIdentity(expected, { ...expected, startIdentity: "987655" }), false);
  assert.equal(matchesProcessIdentity(expected, { ...expected, executableIdentity: "/tmp/node" }), false);
  assert.equal(matchesProcessIdentity(expected, null), false);
});
