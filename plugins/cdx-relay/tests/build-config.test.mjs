import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installSupervisorTeardown, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

installSupervisorTeardown(after);

test("app-server TypeScript config builds from the independent package root", () => {
  const result = run("npm", ["run", "build"], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
