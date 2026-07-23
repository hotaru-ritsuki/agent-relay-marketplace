export type RelayProvider = "codex" | "cursor";
export type JobStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted"
  | "partial";
export type RetrySafety = "safe" | "unsafe" | "unknown";

export interface SafetyPolicy {
  sandbox: string;
  readOnly: boolean;
  network: boolean;
  mcp: boolean;
  approvals: "deny" | "prompt" | "explicit-policy";
  allowConcurrentWrites: boolean;
}

export interface JobRecord {
  schemaVersion: 1;
  provider: RelayProvider;
  pluginVersion: string;
  jobId: string;
  claudeSessionId: string | null;
  workspaceHash: string;
  transport: string;
  model: string;
  safety: SafetyPolicy;
  status: JobStatus;
  providerStatus: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ResultEnvelope {
  schemaVersion: 1;
  provider: RelayProvider;
  pluginVersion: string;
  jobId: string;
  status: JobStatus;
  retrySafety: RetrySafety;
  summary: string;
  finalOutput: string;
  changedFiles: string[];
  error: { code: string; message: string } | null;
}

export interface WorkspaceLease {
  schemaVersion: 1;
  provider: RelayProvider;
  jobId: string;
  workspaceHash: string;
  pid: number;
  processStartedAt: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
}
