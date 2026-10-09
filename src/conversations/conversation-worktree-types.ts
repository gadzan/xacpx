import { ConversationError } from "./conversation-error";

export type WorktreeState = "planned" | "provisioning" | "ready" | "active" | "awaiting-integration"
  | "integrated" | "cleanup-pending" | "cleaned" | "provision-failed" | "missing" | "recovery-required" | "cleanup-failed";
export type IntegrationState = "preparing" | "integrating" | "integrated" | "conflicted" | "failed" | "recovery-required" | "abandoned";
export interface ConversationWorktreeBase {
  workspace: string;
  sourceRoot: string;
  commonDir: string;
  repositoryIdentity: string;
  baseCommitSha: string;
}
export interface ConversationWorktreeRef { runId: string; worktreeId: string; generation: number }
export interface ConversationWorktreeResource {
  id: string; botId: string; kind: "member" | "integration"; generation: number;
  branchRef: string; worktreePath: string; ownerToken: string; state: WorktreeState;
  createdAt: string; updatedAt: string; lastError?: string;
  snapshotSha?: string; snapshotTree?: string; patchSha?: string;
  snapshotParent?: string;
  gitDir?: string;
}
export interface WorktreePreviewMember {
  botId: string; worktreeId: string; head: string; tree: string; files: string[]; diff: string;
}
export interface WorktreeIntegration {
  generation: number; operationSource: "control";
  id: string; requestId: string; previewId: string; state: IntegrationState;
  resourceId: string; orderedBotIds: string[]; patches: string[]; nextIndex: number;
  candidateCommitSha: string; expectedParent?: string; conflictFiles: string[];
  createdAt: string; updatedAt: string; lastError?: string;
}
export interface ConversationWorktreeRun extends ConversationWorktreeBase {
  version: 1; runId: string; conversationId: string; topicId: string; revision: number;
  disposition: "pending" | "integrated" | "abandoned";
  createdAt: string; updatedAt: string; resources: ConversationWorktreeResource[];
  orphanWorktreePaths?: string[];
  preview?: { id: string; createdAt: string; members: WorktreePreviewMember[] };
  integration?: WorktreeIntegration;
}
export type WorktreeOperation =
  | { action: "preview"; runId: string; botIds: string[] }
  | { action: "integrate"; runId: string; requestId: string; previewId: string; snapshotUncommitted: true }
  | { action: "continue" | "recover" | "abandon" | "cleanup"; runId: string };

/** Public projection deliberately excludes opaque ownership tokens/Git internals. */
export function worktreeStatus(run: ConversationWorktreeRun) {
  return { runId: run.runId, baseCommitSha: run.baseCommitSha, disposition: run.disposition, revision: run.revision,
    ...(run.orphanWorktreePaths?.length ? { orphanWorktreePaths: run.orphanWorktreePaths } : {}),
    resources: run.resources.map(r => ({ id: r.id, botId: r.botId, kind: r.kind, state: r.state,
      worktreePath: r.worktreePath, branchRef: r.branchRef, ...(r.snapshotSha ? { snapshotSha: r.snapshotSha } : {}), ...(r.lastError ? { lastError: r.lastError } : {}) })),
    ...(run.preview ? { preview: run.preview } : {}),
    ...(run.integration ? { integration: run.integration } : {}) };
}

const states: WorktreeState[] = ["planned", "provisioning", "ready", "active", "awaiting-integration", "integrated",
  "cleanup-pending", "cleaned", "provision-failed", "missing", "recovery-required", "cleanup-failed"];
const integrationStates: IntegrationState[] = ["preparing", "integrating", "integrated", "conflicted", "failed", "recovery-required", "abandoned"];
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !v.includes("\0");
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v);
const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
export function parseWorktreeRun(value: unknown): ConversationWorktreeRun {
  if (!record(value) || value.version !== 1 || !["pending", "integrated", "abandoned"].includes(value.disposition)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !["runId", "conversationId", "topicId", "workspace", "sourceRoot", "commonDir", "repositoryIdentity", "createdAt", "updatedAt"].every(k => text(value[k]))
    || !sha(value.baseCommitSha) || !Array.isArray(value.resources) || value.resources.length > 256) fail();
  if (value.orphanWorktreePaths !== undefined && !strings(value.orphanWorktreePaths)) fail();
  const ids = new Set<string>(); const bots = new Set<string>();
  for (const r of value.resources) {
    if (!record(r) || !["id", "botId", "branchRef", "worktreePath", "ownerToken", "createdAt", "updatedAt"].every(k => text(r[k]))
      || !["member", "integration"].includes(r.kind) || !states.includes(r.state)
      || !Number.isSafeInteger(r.generation) || r.generation < 1 || ids.has(r.id)
      || !/^[a-f0-9]{24}$/.test(r.id) || !/^xacpx-conversation:[a-f0-9-]{36}$/.test(r.ownerToken)
      || (r.gitDir !== undefined && !text(r.gitDir))
      || (r.lastError !== undefined && typeof r.lastError !== "string")
      || (r.kind === "member" && bots.has(r.botId))
      || [r.snapshotSha, r.snapshotTree, r.patchSha, r.snapshotParent].some(v => v !== undefined && !sha(v))) fail();
    ids.add(r.id); if (r.kind === "member") bots.add(r.botId);
  }
  const p = value.preview;
  if (p !== undefined && (!record(p) || !text(p.id) || !text(p.createdAt) || !Array.isArray(p.members)
    || p.members.some((m: unknown) => !record(m) || !text(m.botId) || !ids.has(m.worktreeId)
      || !sha(m.head) || !sha(m.tree) || !strings(m.files) || typeof m.diff !== "string"))) fail();
  const members = value.resources.filter((r: ConversationWorktreeResource) => r.kind === "member");
  if (p && (p.members.length !== members.length || new Set(p.members.map((m: WorktreePreviewMember) => m.botId)).size !== members.length
    || p.members.some((m: WorktreePreviewMember) => !members.some((r: ConversationWorktreeResource) => r.id === m.worktreeId && r.botId === m.botId)))) fail();
  const i = value.integration;
  if (i !== undefined && (!record(i) || !["id", "requestId", "previewId", "resourceId", "createdAt", "updatedAt"].every(k => text(i[k]))
    || !Number.isSafeInteger(i.generation) || i.generation < 1 || i.operationSource !== "control"
    || !integrationStates.includes(i.state) || !ids.has(i.resourceId) || !strings(i.orderedBotIds)
    || new Set(i.orderedBotIds).size !== i.orderedBotIds.length || !Array.isArray(i.patches) || !i.patches.every(sha)
    || !Number.isInteger(i.nextIndex) || i.nextIndex < 0 || i.nextIndex > i.orderedBotIds.length
    || !sha(i.candidateCommitSha) || (i.expectedParent !== undefined && !sha(i.expectedParent)) || !strings(i.conflictFiles)
    || (i.lastError !== undefined && typeof i.lastError !== "string"))) fail();
  if (i && (!p || p.id !== i.previewId || !value.resources.some((r: ConversationWorktreeResource) => r.id === i.resourceId && r.kind === "integration" && r.botId === i.id)
    || JSON.stringify(i.orderedBotIds) !== JSON.stringify(p.members.map((m: WorktreePreviewMember) => m.botId))
    || (i.patches.length !== 0 && i.patches.length !== i.orderedBotIds.length)
    || (i.nextIndex > 0 && i.patches.length !== i.orderedBotIds.length))) fail();
  if (value.disposition === "integrated" && (!i || i.state !== "integrated" || i.nextIndex !== i.orderedBotIds.length)) fail();
  if (i && ((i.state === "integrated" && value.disposition !== "integrated")
    || (i.state === "abandoned" && value.disposition !== "abandoned")
    || (value.disposition === "abandoned" && i.state !== "abandoned"))) fail();
  return value as ConversationWorktreeRun;
}
function fail(): never { throw new ConversationError("worktree_registry_corrupt", "invalid durable worktree ownership or integration evidence"); }

export function parseWorktreeOperation(v: unknown): WorktreeOperation {
  if (!record(v) || !text(v.runId)) throw new ConversationError("invalid_worktree_operation", "runId is required");
  const fields = v.action === "preview" ? ["action", "runId", "botIds"] : v.action === "integrate"
    ? ["action", "runId", "requestId", "previewId", "snapshotUncommitted"] : ["action", "runId"];
  if (Object.keys(v).some(k => !fields.includes(k)) || !["preview", "integrate", "continue", "recover", "abandon", "cleanup"].includes(v.action)
    || (v.action === "preview" && (!strings(v.botIds) || !v.botIds.length || v.botIds.length > 128 || new Set(v.botIds).size !== v.botIds.length))
    || (v.action === "integrate" && (!text(v.requestId) || v.requestId.length > 128 || !text(v.previewId) || v.snapshotUncommitted !== true))) {
    throw new ConversationError("invalid_worktree_operation", "invalid or unsupported worktree operation fields");
  }
  return v as WorktreeOperation;
}
