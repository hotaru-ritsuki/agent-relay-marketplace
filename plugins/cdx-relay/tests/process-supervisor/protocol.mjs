import { SupervisorInfrastructureError } from "./errors.mjs";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;

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

function assertMessage(type, message, required = []) {
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
  for (const field of ["epoch", "runId", "nonce", ...required]) {
    if (typeof message[field] !== "string" || message[field].length === 0) {
      throw protocolError(
        "PROTOCOL_INVALID_MESSAGE",
        `${type}.${field} must be a nonempty string.`
      );
    }
  }
  return message;
}

export const validateHello = (message) => assertMessage("hello", message);

export function validateLaunch(message) {
  assertMessage("launch", message);
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

export const validateRoot = (message) => assertMessage("root", message);
export const validateStop = (message) => assertMessage("stop", message);
export const validateCleanup = (message) => assertMessage("cleanup", message);
export const validateProof = (message) => assertMessage("proof", message);

export const validators = Object.freeze({
  hello: validateHello,
  launch: validateLaunch,
  root: validateRoot,
  stop: validateStop,
  cleanup: validateCleanup,
  proof: validateProof
});
