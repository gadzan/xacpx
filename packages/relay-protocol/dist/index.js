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
  if ((candidate.kind === "req" || candidate.kind === "res") && (typeof candidate.id !== "string" || candidate.id.length === 0))
    return false;
  return true;
}
// packages/relay-protocol/src/messages.ts
var MSG = {
  instanceRegister: "instance.register",
  instanceAuth: "instance.auth",
  instanceEvent: "instance.event",
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
  upload: "control.upload",
  sessionModelGet: "control.session.model.get",
  sessionModelSet: "control.session.model.set",
  terminalCreate: "control.terminal.create",
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
// packages/relay-protocol/src/web-dtos.ts
var WEB_EVENT_TYPE = "web.event";
function webEventEnvelope(event) {
  return { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: WEB_EVENT_TYPE, payload: event };
}
var WEB_EVENT_KINDS = new Set(["instance-status", "control-event", "notice"]);
var CONTROL_EVENT_TYPES = new Set([
  "turn-output",
  "turn-started",
  "tool-event",
  "turn-thought",
  "plan",
  "turn-usage",
  "agent-commands",
  "turn-finished",
  "queue-updated",
  "sessions-changed",
  "workspaces-changed",
  "scheduled-changed",
  "orchestration-changed",
  "terminal-output",
  "terminal-exit"
]);
var TOOL_STEP_KINDS = new Set(["read", "search", "execute", "edit", "think", "other"]);
var TOOL_STEP_STATUSES = new Set(["running", "success", "error"]);
var isStr = (v) => typeof v === "string";
var optStr = (v) => v === undefined || typeof v === "string";
var optNum = (v) => v === undefined || typeof v === "number";
function validToolDetail(d) {
  switch (d.type) {
    case "diff":
      return isStr(d.path) && isStr(d.oldText) && isStr(d.newText);
    case "read":
      return isStr(d.path) && optStr(d.lines) && optStr(d.preview);
    case "command":
      return isStr(d.command) && optStr(d.output) && optNum(d.exitCode);
    case "search":
      return isStr(d.query) && optStr(d.output);
    case "text":
      return isStr(d.text);
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
function validControlEvent(e) {
  if (typeof e !== "object" || e === null)
    return false;
  const c = e;
  if (typeof c.type !== "string" || !CONTROL_EVENT_TYPES.has(c.type))
    return false;
  if (c.type === "turn-output")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.chunk === "string";
  if (c.type === "turn-finished")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.ok === "boolean";
  if (c.type === "scheduled-changed")
    return typeof c.chatKey === "string";
  if (c.type === "turn-started")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string";
  if (c.type === "turn-thought")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.chunk === "string";
  if (c.type === "plan")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.entries);
  if (c.type === "turn-usage")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.used === "number" && typeof c.size === "number";
  if (c.type === "agent-commands")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.commands) && c.commands.every((x) => x !== null && typeof x === "object" && typeof x.name === "string");
  if (c.type === "queue-updated")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.items);
  if (c.type === "tool-event")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && validToolStep(c.step);
  if (c.type === "terminal-output")
    return typeof c.terminalId === "string" && typeof c.seq === "number" && typeof c.data === "string";
  if (c.type === "terminal-exit")
    return typeof c.terminalId === "string" && typeof c.code === "number";
  return true;
}
var NOTICE_KINDS = new Set(["task-completion", "task-progress", "coordinator-message"]);
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
  if (candidate.kind === "notice" && !validNotice(candidate.notice))
    return null;
  return payload;
}
var WEB_CLIENT_TYPE = "web.client";
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
export {
  webEventEnvelope,
  webClientEnvelope,
  parseWebServerEvent,
  parseWebClientMessage,
  isErrorPayload,
  errorPayload,
  encodeEnvelope,
  decodeEnvelope,
  WEB_EVENT_TYPE,
  WEB_CLIENT_TYPE,
  RELAY_PROTOCOL_VERSION,
  MSG
};
