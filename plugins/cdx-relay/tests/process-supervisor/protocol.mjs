import { SupervisorInfrastructureError } from "./errors.mjs";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const REAPER_OPERATIONS = Object.freeze([
  "probe",
  "launch",
  "cleanup",
  "recover",
  "shutdown"
]);

function protocolError(code, message, options) {
  return new SupervisorInfrastructureError(code, message, options);
}

export function assertBoundedFrame(buffer) {
  if (!Buffer.isBuffer(buffer) && !ArrayBuffer.isView(buffer)) {
    throw protocolError("PROTOCOL_INVALID_FRAME", "Protocol frames must be bytes.");
  }
  if (buffer.byteLength > MAX_FRAME_BYTES) {
    throw protocolError(
      "PROTOCOL_FRAME_TOO_LARGE",
      `Protocol frame exceeds ${MAX_FRAME_BYTES} bytes.`
    );
  }
  return buffer;
}

export function serializeBounded(value) {
  const json = JSON.stringify(value, (_key, item) => {
    if (ArrayBuffer.isView(item) && !Buffer.isBuffer(item)) {
      return {
        type: "Buffer",
        data: Buffer.from(
          item.buffer,
          item.byteOffset,
          item.byteLength
        ).toString("base64")
      };
    }
    if (Buffer.isBuffer(item)) {
      return { type: "Buffer", data: item.toString("base64") };
    }
    if (item?.type === "Buffer" && Array.isArray(item.data)) {
      return {
        type: "Buffer",
        data: Buffer.from(item.data).toString("base64")
      };
    }
    if (item instanceof Error) {
      return {
        name: item.name,
        code: item.code,
        message: item.message
      };
    }
    return item;
  });
  assertBoundedFrame(Buffer.from(json));
  return json;
}

function assertIdentity(message, expected) {
  for (const field of ["epoch", "runId", "nonce"]) {
    if (typeof message[field] !== "string" || message[field].length === 0) {
      throw protocolError(
        "PROTOCOL_INVALID_MESSAGE",
        `${message.type}.${field} must be a nonempty string.`
      );
    }
    if (expected?.[field] && message[field] !== expected[field]) {
      throw protocolError(
        "PROTOCOL_IDENTITY_MISMATCH",
        `${message.type}.${field} does not match the active lease.`
      );
    }
  }
  if (typeof message.backend !== "string" || message.backend.length === 0) {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      `${message.type}.backend must be a nonempty string.`
    );
  }
  if (expected?.backend && message.backend !== expected.backend) {
    throw protocolError(
      "BACKEND_IDENTITY_MISMATCH",
      `${message.type}.backend does not match the active backend.`
    );
  }
}

function assertMessage(type, message, expected) {
  serializeBounded(message);
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw protocolError("PROTOCOL_INVALID_MESSAGE", `${type} must be an object.`);
  }
  if (message.version !== PROTOCOL_VERSION) {
    throw protocolError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `${type} uses unsupported protocol version ${message.version}.`
    );
  }
  if (message.type !== type) {
    throw protocolError("PROTOCOL_INVALID_MESSAGE", `Expected ${type} message.`);
  }
  assertIdentity(message, expected);
  return message;
}

export const validateHello = (message, expected) =>
  assertMessage("hello", message, expected);

export function validateLaunch(message, expected) {
  assertMessage("launch", message, expected);
  if (typeof message.command !== "string" || message.command.length === 0) {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "launch.command must be a nonempty string."
    );
  }
  if (!Array.isArray(message.args) ||
      message.args.some((argument) => typeof argument !== "string")) {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "launch.args must contain only strings."
    );
  }
  return message;
}

export function validateRoot(message, expected) {
  assertMessage("root", message, expected);
  if (message.status !== null && !Number.isInteger(message.status)) {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "root.status must be an integer or null."
    );
  }
  if (message.signal !== null && typeof message.signal !== "string") {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "root.signal must be a string or null."
    );
  }
  for (const field of ["stdout", "stderr"]) {
    const value = message[field];
    if (value !== undefined && value !== null &&
        typeof value !== "string" && !Buffer.isBuffer(value)) {
      throw protocolError(
        "PROTOCOL_INVALID_MESSAGE",
        `root.${field} must be bytes, a string, null, or undefined.`
      );
    }
    if (value !== undefined && value !== null) {
      assertBoundedFrame(Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
  }
  if (message.error !== undefined && message.error !== null &&
      typeof message.error !== "object") {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "root.error must be an object or undefined."
    );
  }
  return message;
}

export function validateStop(message, expected) {
  assertMessage("stop", message, expected);
  if (message.stopped !== true) {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "stop.stopped must prove the stop request was accepted."
    );
  }
  return message;
}
export function validateCleanup(message, expected) {
  assertMessage("cleanup", message, expected);
  if (typeof message.level !== "string" || message.level.length === 0) {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "cleanup.level must be a nonempty cleanup guarantee."
    );
  }
  return message;
}

export function validateProof(message, expected) {
  assertMessage("proof", message, expected);
  if (typeof message.level !== "string" || message.level.length === 0) {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "proof.level must be a nonempty cleanup guarantee."
    );
  }
  return message;
}

export function validateReaperRequest(message, expected) {
  serializeBounded(message);
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "reaper request must be an object."
    );
  }
  if (message.version !== PROTOCOL_VERSION) {
    throw protocolError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `reaper request uses unsupported protocol version ${message.version}.`
    );
  }
  if (!REAPER_OPERATIONS.includes(message.operation)) {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "reaper request operation is unsupported."
    );
  }
  for (const field of ["backend", "reaperBootId"]) {
    if (typeof message[field] !== "string" ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(message[field])) {
      throw protocolError(
        "PROTOCOL_INVALID_MESSAGE",
        `reaper request ${field} must be a safe nonempty identity.`
      );
    }
    if (expected?.[field] && message[field] !== expected[field]) {
      throw protocolError(
        "PROTOCOL_IDENTITY_MISMATCH",
        `reaper request ${field} does not match the protected reaper.`
      );
    }
  }
  for (const field of ["epoch", "runId", "nonce"]) {
    if (typeof message[field] !== "string" || message[field].length === 0) {
      throw protocolError(
        "PROTOCOL_INVALID_MESSAGE",
        `reaper request ${field} must be a nonempty string.`
      );
    }
    if (expected?.[field] && message[field] !== expected[field]) {
      throw protocolError(
        "PROTOCOL_IDENTITY_MISMATCH",
        `reaper request ${field} does not match the active lease.`
      );
    }
    if ((field === "epoch" || field === "runId") &&
        (!/^[A-Za-z0-9._-]+$/.test(message[field]) ||
         message[field].length > 128)) {
      throw protocolError(
        "PROTOCOL_INVALID_MESSAGE",
        `reaper request ${field} is not a safe identity component.`
      );
    }
  }
  if (!message.payload || typeof message.payload !== "object" ||
      Array.isArray(message.payload)) {
    throw protocolError(
      "PROTOCOL_INVALID_MESSAGE",
      "reaper request payload must be an object."
    );
  }
  return message;
}

export function validateKernelDrainedProof(proof, expected) {
  serializeBounded(proof);
  const valid = proof &&
    typeof proof === "object" &&
    !Array.isArray(proof) &&
    proof.version === PROTOCOL_VERSION &&
    proof.operation === "cleanup" &&
    proof.level === "kernel-drained" &&
    proof.epoch === expected.epoch &&
    proof.runId === expected.runId &&
    proof.backend === expected.backend &&
    proof.reaperBootId === expected.reaperBootId &&
    proof.nonceHash === expected.nonceHash &&
    proof.proofTokenHash === expected.proofTokenHash &&
    proof.outerCgroup === expected.outerCgroup &&
    proof.populated === 0 &&
    proof.reaperIdentity === expected.reaperIdentity &&
    typeof proof.drainedAt === "string" &&
    Number.isFinite(Date.parse(proof.drainedAt));
  if (!valid) {
    throw protocolError(
      "CLEANUP_UNPROVEN",
      "The protected outer cgroup did not provide authenticated populated-zero proof."
    );
  }
  return proof;
}

export const validators = Object.freeze({
  hello: validateHello,
  launch: validateLaunch,
  root: validateRoot,
  stop: validateStop,
  cleanup: validateCleanup,
  proof: validateProof
});
