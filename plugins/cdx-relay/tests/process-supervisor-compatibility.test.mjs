import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  compatibilityBackend
} from "./helpers.mjs";
import { createProcessSupervisor } from "./process-supervisor/index.mjs";

test("compatibility backend rejects a stop proof when child.kill returns false", async (t) => {
  const rawChild = new EventEmitter();
  rawChild.pid = 123;
  rawChild.stdout = null;
  rawChild.stderr = null;
  rawChild.kill = () => false;
  const supervisor = createProcessSupervisor({
    platform: process.platform,
    backendFactories: [() => compatibilityBackend({
      spawnTrackedImpl: async () => rawChild
    })]
  });
  t.after(async () => {
    try {
      await supervisor.shutdown();
    } catch {
      // The rejected stop proof intentionally poisons this supervisor.
    }
  });
  const child = await supervisor.spawnTracked({
    command: "fake",
    args: [],
    stdio: "ignore"
  });

  assert.equal(child.kill(), false);
  assert.throws(
    () => supervisor.assertHealthy(),
    (error) => error.code === "PROTOCOL_INVALID_MESSAGE"
  );
  rawChild.emit("exit", 0, null);
  rawChild.emit("close", 0, null);
  await child.completion;
});
