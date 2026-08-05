// packages/relay-protocol/src/envelope.ts
var RELAY_PROTOCOL_VERSION = 1;
function encodeEnvelope(envelope) {
  return JSON.stringify(envelope);
}
function decodeEnvelope(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!isEnvelopeShape(raw)) {
    return { ok: false, error: "invalid-envelope" };
  }
  if (raw.protocolVersion !== RELAY_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: "version-mismatch",
      detail: `expected protocolVersion ${RELAY_PROTOCOL_VERSION}, got ${raw.protocolVersion}`
    };
  }
  return { ok: true, envelope: raw };
}
function isEnvelopeShape(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value;
  if (typeof candidate.protocolVersion !== "number" || !Number.isInteger(candidate.protocolVersion))
    return false;
  if (candidate.kind !== "req" && candidate.kind !== "res" && candidate.kind !== "event")
    return false;
  if (typeof candidate.type !== "string" || candidate.type.trim().length === 0)
    return false;
  if (candidate.id !== undefined && typeof candidate.id !== "string")
    return false;
  if (candidate.requestDeadlineAt !== undefined && (typeof candidate.requestDeadlineAt !== "number" || !Number.isFinite(candidate.requestDeadlineAt) || candidate.requestDeadlineAt <= 0))
    return false;
  if (candidate.requestBudgetMs !== undefined && (typeof candidate.requestBudgetMs !== "number" || !Number.isFinite(candidate.requestBudgetMs) || candidate.requestBudgetMs <= 0))
    return false;
  if ((candidate.kind === "req" || candidate.kind === "res") && (typeof candidate.id !== "string" || candidate.id.length === 0))
    return false;
  return true;
}
// packages/relay-protocol/src/limits.ts
var STATE_SYNC_TEXT_CAP = 256 * 1024;
var STATE_SYNC_PARTS_CAP = 1000;
var MAX_TOOL_STEPS = 200;
var REASONING_CAP = 16000;
var RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// packages/relay-protocol/src/messages.ts
var MSG = {
  instanceRegister: "instance.register",
  instanceAuth: "instance.auth",
  instanceEvent: "instance.event",
  instanceStateSync: "instance.state.sync",
  instanceRecoveryAck: "instance.recovery.ack",
  instanceNotice: "instance.notice",
  sessionsList: "control.sessions.list",
  sessionsCreate: "control.sessions.create",
  sessionsNativeList: "control.sessions.native.list",
  sessionsRemove: "control.sessions.remove",
  sessionsArchive: "control.sessions.archive",
  sessionsUnarchive: "control.sessions.unarchive",
  sessionsRename: "control.sessions.rename",
  agentsList: "control.agents.list",
  workspacesList: "control.workspaces.list",
  workspacesCreate: "control.workspaces.create",
  agentsCatalog: "control.agents.catalog",
  agentsCreate: "control.agents.create",
  agentsRemove: "control.agents.remove",
  workspacesRemove: "control.workspaces.remove",
  prompt: "control.prompt",
  promptCancel: "control.prompt.cancel",
  queueCancel: "control.queue.cancel",
  commandExecute: "control.command.execute",
  scheduledList: "control.scheduled.list",
  scheduledCreate: "control.scheduled.create",
  scheduledCancel: "control.scheduled.cancel",
  orchestrationList: "control.orchestration.list",
  orchestrationGet: "control.orchestration.get",
  orchestrationCancel: "control.orchestration.cancel",
  fsList: "control.fs.list",
  fsRead: "control.fs.read",
  fsDiff: "control.fs.diff",
  fsSearch: "control.fs.search",
  fsCreate: "control.fs.create",
  fsRename: "control.fs.rename",
  fsDelete: "control.fs.delete",
  fsCopy: "control.fs.copy",
  fsDownload: "control.fs.download",
  fsWrite: "control.fs.write",
  gitStatus: "control.git.status",
  gitStage: "control.git.stage",
  gitUnstage: "control.git.unstage",
  gitUntrack: "control.git.untrack",
  gitDiscard: "control.git.discard",
  gitCommit: "control.git.commit",
  gitFetch: "control.git.fetch",
  gitPull: "control.git.pull",
  gitPush: "control.git.push",
  gitCheckout: "control.git.checkout",
  gitWorktreeCreate: "control.git.worktree.create",
  upload: "control.upload",
  sessionModelGet: "control.session.model.get",
  sessionModelSet: "control.session.model.set",
  sessionEffortGet: "control.session.effort.get",
  sessionEffortSet: "control.session.effort.set",
  terminalCreate: "control.terminal.create",
  terminalAttach: "control.terminal.attach",
  terminalInput: "instance.terminal.input",
  terminalResize: "instance.terminal.resize",
  terminalClose: "instance.terminal.close"
};
function errorPayload(code, message) {
  return { error: { code, message } };
}
function isErrorPayload(payload) {
  if (typeof payload !== "object" || payload === null)
    return false;
  const candidate = payload.error;
  if (typeof candidate !== "object" || candidate === null)
    return false;
  const error = candidate;
  return typeof error.code === "string" && typeof error.message === "string";
}
// packages/relay-protocol/src/validate-primitives.ts
var isObj = (v) => typeof v === "object" && v !== null;
var isStr = (v) => typeof v === "string";
var optStr = (v) => v === undefined || typeof v === "string";
var optNum = (v) => v === undefined || typeof v === "number";
var optBool = (v) => v === undefined || typeof v === "boolean";

// packages/relay-protocol/src/web-dtos.ts
var WEB_EVENT_TYPE = "web.event";
function webEventEnvelope(event) {
  return { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: WEB_EVENT_TYPE, payload: event };
}
var WEB_EVENT_KINDS = new Set(["instance-status", "control-event", "state-snapshot", "notice"]);
var CONTROL_EVENT_TYPE_MAP = {
  "turn-output": true,
  "turn-started": true,
  "tool-event": true,
  "turn-thought": true,
  plan: true,
  "turn-usage": true,
  "agent-commands": true,
  "turn-finished": true,
  "queue-updated": true,
  "sessions-changed": true,
  "workspaces-changed": true,
  "scheduled-changed": true,
  "session-history": true,
  "orchestration-changed": true,
  "terminal-output": true,
  "terminal-exit": true
};
var CONTROL_EVENT_TYPES = new Set(Object.keys(CONTROL_EVENT_TYPE_MAP));
var TOOL_STEP_KINDS = new Set(["read", "search", "execute", "edit", "think", "other"]);
var TOOL_STEP_STATUSES = new Set(["running", "success", "error"]);
var finiteNonNegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
function validUsageCost(value) {
  if (value === undefined)
    return true;
  if (typeof value !== "object" || value === null)
    return false;
  const c = value;
  return (c.amount === undefined || finiteNonNegative(c.amount)) && (c.currency === undefined || typeof c.currency === "string" && c.currency.length <= 32);
}
function validUsageBreakdown(value) {
  if (value === undefined)
    return true;
  if (typeof value !== "object" || value === null)
    return false;
  const c = value;
  return ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"].every((key) => c[key] === undefined || finiteNonNegative(c[key]));
}
function validAgentCommand(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const c = value;
  return typeof c.name === "string" && c.name.length > 0 && c.name.length <= 128 && (c.description === undefined || typeof c.description === "string" && c.description.length <= 4096) && (c.hasInput === undefined || typeof c.hasInput === "boolean");
}
function validScheduledOrigin(s) {
  return s === undefined || typeof s === "object" && s !== null && isStr(s.taskId) && isStr(s.executeAt);
}
function validToolDetail(d) {
  switch (d.type) {
    case "diff":
      return isStr(d.path) && isStr(d.oldText) && isStr(d.newText) && optStr(d.instruction);
    case "read":
      return isStr(d.path) && optStr(d.lines) && optStr(d.preview);
    case "command":
      return isStr(d.command) && optStr(d.output) && optNum(d.exitCode);
    case "search":
      return isStr(d.query) && optStr(d.output);
    case "text":
      return isStr(d.text) && optStr(d.output);
    case "fields":
      return Array.isArray(d.fields) && d.fields.every((f) => f !== null && typeof f === "object" && isStr(f.label) && isStr(f.value)) && optStr(d.output);
    default:
      return false;
  }
}
function validToolStep(s) {
  if (typeof s !== "object" || s === null)
    return false;
  const c = s;
  if (typeof c.toolCallId !== "string" || typeof c.toolName !== "string" || typeof c.title !== "string")
    return false;
  if (typeof c.kind !== "string" || !TOOL_STEP_KINDS.has(c.kind))
    return false;
  if (typeof c.status !== "string" || !TOOL_STEP_STATUSES.has(c.status))
    return false;
  if (!optStr(c.parentToolCallId) || c.isSubagent !== undefined && typeof c.isSubagent !== "boolean")
    return false;
  if (c.durationMs !== undefined && !finiteNonNegative(c.durationMs))
    return false;
  if (!optStr(c.error))
    return false;
  if (c.detail !== undefined) {
    if (typeof c.detail !== "object" || c.detail === null)
      return false;
    if (!validToolDetail(c.detail))
      return false;
  }
  return true;
}
function validTurnPart(p) {
  if (typeof p !== "object" || p === null)
    return false;
  const c = p;
  if (c.type === "text" || c.type === "reasoning")
    return typeof c.text === "string";
  if (c.type === "tool")
    return validToolStep(c.step);
  return false;
}
function validStateSyncParts(parts) {
  if (parts.length > STATE_SYNC_PARTS_CAP || !parts.every(validTurnPart))
    return false;
  let textLength = 0;
  let reasoningLength = 0;
  const toolIds = new Set;
  for (const raw of parts) {
    const part = raw;
    if (part.type === "text")
      textLength += part.text.length;
    else if (part.type === "reasoning")
      reasoningLength += part.text.length;
    else
      toolIds.add(part.step.toolCallId);
  }
  return textLength <= STATE_SYNC_TEXT_CAP && reasoningLength <= REASONING_CAP && toolIds.size <= MAX_TOOL_STEPS;
}
function validStateSnapshot(candidate) {
  const instanceId = candidate.instanceId;
  if (typeof instanceId !== "string")
    return false;
  if (!Array.isArray(candidate.turns) || !candidate.turns.every((turn) => {
    if (typeof turn !== "object" || turn === null)
      return false;
    const c = turn;
    return c.instanceId === instanceId && typeof c.sessionAlias === "string" && Array.isArray(c.parts) && c.parts.every(validTurnPart) && (c.status === "working" || c.status === "streaming") && finiteNonNegative(c.startedAt);
  }))
    return false;
  if (!Array.isArray(candidate.usage) || !candidate.usage.every((usage) => {
    if (typeof usage !== "object" || usage === null)
      return false;
    const c = usage;
    return c.instanceId === instanceId && typeof c.sessionAlias === "string" && finiteNonNegative(c.used) && finiteNonNegative(c.size) && validUsageCost(c.cost) && validUsageBreakdown(c.breakdown);
  }))
    return false;
  return Array.isArray(candidate.commands) && candidate.commands.every((entry) => {
    if (typeof entry !== "object" || entry === null)
      return false;
    const c = entry;
    return c.instanceId === instanceId && typeof c.sessionAlias === "string" && Array.isArray(c.commands) && c.commands.every(validAgentCommand);
  });
}
function validControlEvent(e) {
  if (typeof e !== "object" || e === null)
    return false;
  const c = e;
  if (typeof c.type !== "string" || !CONTROL_EVENT_TYPES.has(c.type))
    return false;
  const type = c.type;
  switch (type) {
    case "turn-output":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.chunk === "string";
    case "turn-finished":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.ok === "boolean" && optStr(c.text) && optStr(c.recoveryId) && optStr(c.errorMessage) && optBool(c.cancelled);
    case "scheduled-changed":
      return typeof c.chatKey === "string";
    case "turn-started":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && optStr(c.prompt) && optStr(c.queueItemId) && optStr(c.promptRequestId) && validScheduledOrigin(c.scheduled);
    case "turn-thought":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.chunk === "string";
    case "plan":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.entries);
    case "turn-usage":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && finiteNonNegative(c.used) && finiteNonNegative(c.size) && validUsageCost(c.cost) && validUsageBreakdown(c.breakdown);
    case "agent-commands":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.commands) && c.commands.every(validAgentCommand);
    case "queue-updated":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.items);
    case "session-history":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.messages) && c.messages.every((m) => m !== null && typeof m === "object" && (m.direction === "in" || m.direction === "out") && typeof m.text === "string");
    case "tool-event":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && validToolStep(c.step);
    case "terminal-output":
      return typeof c.terminalId === "string" && typeof c.seq === "number" && typeof c.data === "string";
    case "terminal-exit":
      return typeof c.terminalId === "string" && typeof c.code === "number";
    case "sessions-changed":
    case "workspaces-changed":
    case "orchestration-changed":
      return true;
    default: {
      const _exhaustive = type;
      return _exhaustive;
    }
  }
}
var NOTICE_KINDS = new Set(["task-completion", "task-progress", "coordinator-message"]);
function validInstanceStateSync(p) {
  if (typeof p !== "object" || p === null)
    return false;
  const c = p;
  if (!Array.isArray(c.turns) || !c.turns.every((t) => {
    if (typeof t !== "object" || t === null)
      return false;
    const turn = t;
    return typeof turn.sessionAlias === "string" && optStr(turn.prompt) && optStr(turn.queueItemId) && optStr(turn.recoveryId) && optStr(turn.promptRequestId) && validScheduledOrigin(turn.scheduled) && finiteNonNegative(turn.startedAt) && typeof turn.text === "string" && typeof turn.reasoning === "string" && Array.isArray(turn.steps) && turn.steps.every(validToolStep) && (turn.parts === undefined || Array.isArray(turn.parts) && validStateSyncParts(turn.parts)) && (turn.truncated === undefined || typeof turn.truncated === "boolean");
  }))
    return false;
  if (!Array.isArray(c.usage) || !c.usage.every((u) => {
    if (typeof u !== "object" || u === null)
      return false;
    const usage = u;
    return typeof usage.sessionAlias === "string" && finiteNonNegative(usage.used) && finiteNonNegative(usage.size) && validUsageCost(usage.cost) && validUsageBreakdown(usage.breakdown);
  }))
    return false;
  if (!Array.isArray(c.commands) || !c.commands.every((entry) => {
    if (typeof entry !== "object" || entry === null)
      return false;
    const commands = entry;
    return typeof commands.sessionAlias === "string" && Array.isArray(commands.commands) && commands.commands.every(validAgentCommand);
  }))
    return false;
  return Array.isArray(c.finishedOffline) && c.finishedOffline.every((f) => {
    if (typeof f !== "object" || f === null)
      return false;
    const finished = f;
    return typeof finished.sessionAlias === "string" && typeof finished.ok === "boolean" && optStr(finished.errorMessage) && optStr(finished.text) && optStr(finished.prompt) && optStr(finished.queueItemId) && optStr(finished.recoveryId) && optStr(finished.promptRequestId) && validScheduledOrigin(finished.scheduled) && (finished.cancelled === undefined || typeof finished.cancelled === "boolean") && (finished.truncated === undefined || typeof finished.truncated === "boolean");
  });
}
function validNotice(n) {
  if (typeof n !== "object" || n === null)
    return false;
  const c = n;
  return typeof c.kind === "string" && NOTICE_KINDS.has(c.kind) && typeof c.text === "string";
}
function parseWebServerEvent(envelope) {
  if (envelope.kind !== "event" || envelope.type !== WEB_EVENT_TYPE)
    return null;
  const payload = envelope.payload;
  if (typeof payload !== "object" || payload === null)
    return null;
  const candidate = payload;
  if (typeof candidate.instanceId !== "string")
    return null;
  if (typeof candidate.kind !== "string" || !WEB_EVENT_KINDS.has(candidate.kind))
    return null;
  if (candidate.kind === "instance-status" && typeof candidate.online !== "boolean")
    return null;
  if (candidate.kind === "control-event" && !validControlEvent(candidate.event))
    return null;
  if (candidate.kind === "state-snapshot" && !validStateSnapshot(candidate))
    return null;
  if (candidate.kind === "notice" && !validNotice(candidate.notice))
    return null;
  return payload;
}
var WEB_CLIENT_TYPE = "web.client";
var MAX_WEB_INSTANCE_ID_LENGTH = 128;
function webClientEnvelope(msg) {
  return { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: WEB_CLIENT_TYPE, payload: msg };
}
function parseWebClientMessage(envelope) {
  if (envelope.kind !== "event" || envelope.type !== WEB_CLIENT_TYPE)
    return null;
  const p = envelope.payload;
  if (typeof p !== "object" || p === null)
    return null;
  const c = p;
  if (c.kind === "subscribe") {
    return Array.isArray(c.instanceIds) && c.instanceIds.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_WEB_INSTANCE_ID_LENGTH) ? p : null;
  }
  if (typeof c.instanceId !== "string" || typeof c.terminalId !== "string")
    return null;
  if (c.kind === "terminal-input")
    return typeof c.data === "string" ? p : null;
  if (c.kind === "terminal-resize")
    return typeof c.cols === "number" && typeof c.rows === "number" ? p : null;
  if (c.kind === "terminal-close")
    return p;
  return null;
}
// packages/relay-protocol/src/payload-validators.ts
var fields = (p) => isObj(p) ? p : null;
var optArr = (v) => v === undefined || Array.isArray(v);
var isStrArr = (v) => Array.isArray(v) && v.every(isStr);
var validateSessionsList = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && optNum(o.offset) && optNum(o.limit) && optBool(o.includeArchived) ? o : null;
};
var validateSessionsCreate = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) && isStr(o.agent) && isStr(o.workspace) && optStr(o.agentSessionId) && optStr(o.model) ? o : null;
};
var validateSessionsNativeList = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.agent) && isStr(o.workspace) ? o : null;
};
var validateSessionsRemove = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) ? o : null;
};
var validateSessionsArchive = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) ? o : null;
};
var validateSessionsUnarchive = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) ? o : null;
};
var validateSessionsRename = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) && isStr(o.displayName) ? o : null;
};
var validateWorkspacesCreate = (p) => {
  const o = fields(p);
  return o && isStr(o.name) && isStr(o.cwd) && optStr(o.description) ? o : null;
};
var validateAgentsCreate = (p) => {
  const o = fields(p);
  return o && isStr(o.name) && isStr(o.driver) ? o : null;
};
var validateAgentsRemove = (p) => {
  const o = fields(p);
  return o && isStr(o.name) ? o : null;
};
var validateWorkspacesRemove = (p) => {
  const o = fields(p);
  return o && isStr(o.name) ? o : null;
};
var validatePrompt = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.text) && isStr(o.senderId) && optBool(o.isOwner) && optArr(o.media) && optStr(o.promptRequestId) ? o : null;
};
var validatePromptCancel = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) ? o : null;
};
var validateQueueCancel = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.itemId) ? o : null;
};
var validateCommandExecute = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.text) && isStr(o.senderId) && optBool(o.isOwner) ? o : null;
};
var validateScheduledList = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) ? o : null;
};
var validateScheduledCreate = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.executeAt) && isStr(o.message) ? o : null;
};
var validateScheduledCancel = (p) => {
  const o = fields(p);
  return o && isStr(o.id) && isStr(o.chatKey) ? o : null;
};
var validateOrchestrationGet = (p) => {
  const o = fields(p);
  return o && isStr(o.taskId) ? o : null;
};
var validateOrchestrationCancel = (p) => {
  const o = fields(p);
  return o && isStr(o.taskId) ? o : null;
};
var validateFsList = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && optStr(o.path) ? o : null;
};
var validateFsRead = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? o : null;
};
var validateFsDiff = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && optStr(o.path) ? o : null;
};
var validateFsSearch = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.query) && (o.mode === undefined || o.mode === "name" || o.mode === "content") && optBool(o.matchCase) && optBool(o.wholeWord) && optBool(o.regex) && optStr(o.include) && optStr(o.exclude) && optStr(o.path) ? o : null;
};
var validateFsCreate = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) && (o.kind === "file" || o.kind === "dir") ? o : null;
};
var validateFsRename = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) && isStr(o.newName) ? o : null;
};
var validateFsDelete = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? o : null;
};
var validateFsCopy = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? o : null;
};
var validateFsDownload = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? o : null;
};
var validateFsWrite = (p) => {
  const o = fields(p);
  if (!o || !isStr(o.workspace) || !isStr(o.path) || !isStr(o.content))
    return null;
  const exp = fields(o.expected);
  if (!exp || typeof exp.mtimeMs !== "number" || typeof exp.size !== "number")
    return null;
  return o;
};
var validateGitStatus = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) ? o : null;
};
var validateGitPaths = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStrArr(o.paths) ? o : null;
};
var validateGitCommit = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.message) ? o : null;
};
var validateGitFetch = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && optStr(o.remote) ? o : null;
};
var validateGitPull = validateGitStatus;
var validateGitPush = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && optBool(o.setUpstream) && optStr(o.remote) ? o : null;
};
var validateGitCheckout = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.branch) && optBool(o.create) && optStr(o.startPoint) ? o : null;
};
var validateGitWorktreeCreate = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.workspaceName) && isStr(o.branch) && optBool(o.createBranch) && optStr(o.startPoint) && o.path === undefined ? o : null;
};
var validateSessionModelGet = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) ? o : null;
};
var validateSessionModelSet = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.modelId) ? o : null;
};
var validateSessionEffortGet = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) ? o : null;
};
var validateSessionEffortSet = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.effort) ? o : null;
};
var validateTerminalCreate = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && optNum(o.cols) && optNum(o.rows) ? o : null;
};
var validateTerminalAttach = (p) => {
  const o = fields(p);
  return o && isStr(o.terminalId) ? o : null;
};
var validateUpload = (p) => {
  const o = fields(p);
  return o && isStr(o.filename) && isStr(o.content) && isStr(o.mimeType) ? o : null;
};
var CONTROL_PAYLOAD_VALIDATORS = {
  [MSG.sessionsList]: validateSessionsList,
  [MSG.sessionsCreate]: validateSessionsCreate,
  [MSG.sessionsNativeList]: validateSessionsNativeList,
  [MSG.sessionsRemove]: validateSessionsRemove,
  [MSG.sessionsArchive]: validateSessionsArchive,
  [MSG.sessionsUnarchive]: validateSessionsUnarchive,
  [MSG.sessionsRename]: validateSessionsRename,
  [MSG.workspacesCreate]: validateWorkspacesCreate,
  [MSG.agentsCreate]: validateAgentsCreate,
  [MSG.agentsRemove]: validateAgentsRemove,
  [MSG.workspacesRemove]: validateWorkspacesRemove,
  [MSG.prompt]: validatePrompt,
  [MSG.promptCancel]: validatePromptCancel,
  [MSG.queueCancel]: validateQueueCancel,
  [MSG.commandExecute]: validateCommandExecute,
  [MSG.scheduledList]: validateScheduledList,
  [MSG.scheduledCreate]: validateScheduledCreate,
  [MSG.scheduledCancel]: validateScheduledCancel,
  [MSG.orchestrationGet]: validateOrchestrationGet,
  [MSG.orchestrationCancel]: validateOrchestrationCancel,
  [MSG.fsList]: validateFsList,
  [MSG.fsRead]: validateFsRead,
  [MSG.fsDiff]: validateFsDiff,
  [MSG.fsSearch]: validateFsSearch,
  [MSG.fsCreate]: validateFsCreate,
  [MSG.fsRename]: validateFsRename,
  [MSG.fsDelete]: validateFsDelete,
  [MSG.fsCopy]: validateFsCopy,
  [MSG.fsDownload]: validateFsDownload,
  [MSG.fsWrite]: validateFsWrite,
  [MSG.gitStatus]: validateGitStatus,
  [MSG.gitStage]: validateGitPaths,
  [MSG.gitUnstage]: validateGitPaths,
  [MSG.gitUntrack]: validateGitPaths,
  [MSG.gitDiscard]: validateGitPaths,
  [MSG.gitCommit]: validateGitCommit,
  [MSG.gitFetch]: validateGitFetch,
  [MSG.gitPull]: validateGitPull,
  [MSG.gitPush]: validateGitPush,
  [MSG.gitCheckout]: validateGitCheckout,
  [MSG.gitWorktreeCreate]: validateGitWorktreeCreate,
  [MSG.sessionModelGet]: validateSessionModelGet,
  [MSG.sessionModelSet]: validateSessionModelSet,
  [MSG.sessionEffortGet]: validateSessionEffortGet,
  [MSG.sessionEffortSet]: validateSessionEffortSet,
  [MSG.terminalCreate]: validateTerminalCreate,
  [MSG.terminalAttach]: validateTerminalAttach,
  [MSG.upload]: validateUpload
};
function parseControlPayload(type, payload) {
  const validate = CONTROL_PAYLOAD_VALIDATORS[type];
  return validate(payload);
}
export {
  webEventEnvelope,
  webClientEnvelope,
  validInstanceStateSync,
  validControlEvent,
  parseWebServerEvent,
  parseWebClientMessage,
  parseControlPayload,
  optStr,
  optNum,
  optBool,
  isStr,
  isObj,
  isErrorPayload,
  errorPayload,
  encodeEnvelope,
  decodeEnvelope,
  WEB_EVENT_TYPE,
  WEB_CLIENT_TYPE,
  STATE_SYNC_TEXT_CAP,
  STATE_SYNC_PARTS_CAP,
  RELAY_PROTOCOL_VERSION,
  RECOVERY_RETENTION_MS,
  REASONING_CAP,
  MSG,
  MAX_WEB_INSTANCE_ID_LENGTH,
  MAX_TOOL_STEPS,
  CONTROL_PAYLOAD_VALIDATORS
};
