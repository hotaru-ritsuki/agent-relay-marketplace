import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateAppServerTypes } from "../tooling/generate-app-server-types.mjs";

test("type generation creates its directory and uses argument-array spawning", () => {
  const outputDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdx-types-")), "types with spaces");
  let call;

  generateAppServerTypes({
    codexCommand: "codex",
    outputDir,
    spawnSyncImpl(command, args, options) {
      call = { command, args, options };
      return { status: 0 };
    }
  });

  assert.equal(fs.existsSync(outputDir), true);
  assert.equal(call.command, "codex");
  assert.deepEqual(call.args, ["app-server", "generate-ts", "--out", outputDir]);
  assert.equal(call.options.shell, false);
});

test("type generation bypasses the Windows command shim without using a shell", {
  skip: process.platform !== "win32"
}, () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-shim-"));
  const codexEntrypoint = path.join(fixtureDir, "node_modules", "@openai", "codex", "bin", "codex.js");
  const outputDir = path.join(fixtureDir, "types");
  fs.mkdirSync(path.dirname(codexEntrypoint), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "codex.cmd"), "@echo off\r\n", "utf8");
  fs.writeFileSync(codexEntrypoint, "", "utf8");
  const originalPath = process.env.PATH;
  process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath}`;
  let call;

  try {
    generateAppServerTypes({
      outputDir,
      spawnSyncImpl(command, args, options) {
        call = { command, args, options };
        return { status: 0 };
      }
    });
  } finally {
    process.env.PATH = originalPath;
  }

  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, [codexEntrypoint, "app-server", "generate-ts", "--out", outputDir]);
  assert.equal(call.options.shell, false);
});

test("type generation reports a nonzero Codex exit status", () => {
  const outputDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdx-types-")), "types");

  assert.throws(
    () => generateAppServerTypes({
      outputDir,
      spawnSyncImpl() {
        return { status: 17 };
      }
    }),
    /Codex type generation failed with status 17/
  );
});

test("type generation reports a Codex spawn failure", () => {
  const outputDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdx-types-")), "types");
  const spawnError = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });

  assert.throws(
    () => generateAppServerTypes({
      outputDir,
      spawnSyncImpl() {
        return { status: null, error: spawnError };
      }
    }),
    /Unable to start Codex type generation: spawn codex ENOENT/
  );
});
