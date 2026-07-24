export class SupervisorInfrastructureError extends Error {
  constructor(code, message, { cause, result } = {}) {
    super(`${code}: ${message}`, { cause });
    this.name = "SupervisorInfrastructureError";
    this.code = code;
    this.result = result;
  }
}

export class SupervisorCleanupError extends SupervisorInfrastructureError {
  constructor(summary, options = {}) {
    super(
      "CLEANUP_UNPROVEN",
      "One or more supervised boundaries did not prove cleanup.",
      { ...options, result: summary }
    );
    this.name = "SupervisorCleanupError";
    this.summary = summary;
  }
}
