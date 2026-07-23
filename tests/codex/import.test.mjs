import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const plugin = path.join(root, "plugins", "cdx-relay");

test("Codex Relay import preserves identity, commands, and provenance", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "cdx-relay");
  assert.equal(manifest.version, "1.1.6");
  for (const name of ["rescue", "transfer", "review", "adversarial-review", "setup", "status", "result", "cancel"]) {
    assert.ok(fs.existsSync(path.join(plugin, "commands", `${name}.md`)), name);
  }
  assert.match(fs.readFileSync(path.join(plugin, "LICENSE"), "utf8"), /Apache License/);
  assert.match(fs.readFileSync(path.join(plugin, "NOTICE"), "utf8"), /OpenAI/);
  const provenance = fs.readFileSync(path.join(plugin, "PROVENANCE.md"), "utf8");
  assert.match(provenance, /9000f8fbfcf846531b2a8bce4756cfe2d2798b52/);
  assert.match(provenance, /db52e28f4d9ded852ab3942cea316258ae4ef346/);
});
