import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "../../tooling/lib/fs-walk.mjs";
import * as syncModule from "../../tooling/sync-contracts.mjs";

const { syncContracts } = syncModule;

test("listFiles orders paths by ordinal code units", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-file-order-"));
  const upper = path.join(temp, "Z.schema.json");
  const lower = path.join(temp, "a.schema.json");
  fs.writeFileSync(upper, "");
  fs.writeFileSync(lower, "");

  assert.deepEqual(listFiles(temp), [upper, lower]);
});

test("isDirectInvocation matches equivalent Windows path spellings", () => {
  const moduleUrl = new URL("../../tooling/sync-contracts.mjs", import.meta.url);
  const equivalentArgvPath = fileURLToPath(moduleUrl).toUpperCase().replaceAll("\\", "/");

  assert.equal(typeof syncModule.isDirectInvocation, "function");
  assert.equal(
    syncModule.isDirectInvocation({
      argvPath: equivalentArgvPath,
      moduleUrl,
      platform: "win32"
    }),
    true
  );
});

test("syncContracts copies schemas and declarations into each plugin", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-contracts-"));
  const rootDir = fileURLToPath(new URL("../..", import.meta.url));
  const pluginDirs = [path.join(temp, "cdx-relay"), path.join(temp, "cursor-relay")];
  const canonicalSchemas = listFiles(path.join(rootDir, "contracts", "schemas"));
  const canonicalDeclaration = path.join(rootDir, "contracts", "types", "relay.d.ts");
  syncContracts({ rootDir, pluginDirs });

  for (const pluginDir of pluginDirs) {
    assert.deepEqual(
      fs.readFileSync(path.join(pluginDir, "types", "relay.d.ts")),
      fs.readFileSync(canonicalDeclaration)
    );
    for (const canonicalSchema of canonicalSchemas) {
      assert.deepEqual(
        fs.readFileSync(
          path.join(pluginDir, "schemas", "agent-relay", path.basename(canonicalSchema))
        ),
        fs.readFileSync(canonicalSchema)
      );
    }
  }
});
