import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncContracts } from "../../tooling/sync-contracts.mjs";

test("syncContracts copies schemas and declarations into each plugin", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-"));
  const rootDir = fileURLToPath(new URL("../..", import.meta.url));
  const pluginDirs = [path.join(temp, "cdx-relay"), path.join(temp, "cursor-relay")];
  syncContracts({ rootDir, pluginDirs });

  for (const pluginDir of pluginDirs) {
    assert.equal(
      fs.readFileSync(path.join(pluginDir, "types", "relay.d.ts"), "utf8"),
      fs.readFileSync(path.join(rootDir, "contracts", "types", "relay.d.ts"), "utf8")
    );
    assert.ok(fs.existsSync(path.join(pluginDir, "schemas", "agent-relay", "job.schema.json")));
    assert.ok(fs.existsSync(path.join(pluginDir, "schemas", "agent-relay", "result.schema.json")));
    assert.ok(fs.existsSync(path.join(pluginDir, "schemas", "agent-relay", "lease.schema.json")));
  }
});
