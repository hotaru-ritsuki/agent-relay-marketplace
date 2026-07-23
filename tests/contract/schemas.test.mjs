import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

const schemas = [
  "contracts/schemas/common.schema.json",
  "contracts/schemas/job.schema.json",
  "contracts/schemas/result.schema.json",
  "contracts/schemas/lease.schema.json"
].map(readJson);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);

test("valid contract fixtures satisfy their schemas", () => {
  for (const [schemaId, fixture] of [
    ["https://agent-relay.dev/schemas/v1/job", "contracts/fixtures/job.completed.json"],
    ["https://agent-relay.dev/schemas/v1/result", "contracts/fixtures/result.completed.json"],
    ["https://agent-relay.dev/schemas/v1/lease", "contracts/fixtures/lease.cursor.json"]
  ]) {
    const validate = ajv.getSchema(schemaId);
    assert.ok(validate, `missing ${schemaId}`);
    assert.equal(validate(readJson(fixture)), true, JSON.stringify(validate.errors));
  }
});

test("unknown job statuses are rejected", () => {
  const validate = ajv.getSchema("https://agent-relay.dev/schemas/v1/job");
  assert.equal(validate(readJson("contracts/fixtures/job.invalid-status.json")), false);
  assert.match(JSON.stringify(validate.errors), /status/);
});
