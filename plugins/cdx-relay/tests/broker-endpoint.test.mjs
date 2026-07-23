import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../scripts/lib/broker-endpoint.mjs";

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
