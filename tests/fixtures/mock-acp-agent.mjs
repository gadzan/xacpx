#!/usr/bin/env node
// Dependency-free ACP v1 mock agent for xacpx compat tests.
//
// Behaviors:
// - Full ACP v1 initialize handshake (protocolVersion 1).
// - new/load/resume/list/close/cancel/set_mode/set_model sessions.
// - Every prompt replies with an `agent_message_chunk` whose text echoes the
//   process argv as JSON — `argv=<JSON>` — so tests can assert EXACT launch
//   boundaries (path with spaces, backslashes, empty strings) reached the agent
//   un-split. Also echoes the cwd and the session id.
// - A prompt text of `fail-once` errors once then succeeds, for retry tests.
//
// Sessions are in-memory per process; resume accepts any id (like a real
// server-side adapter), so acpx can resume across agent restarts.

import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Sessions survive across agent processes (a real agent server keeps them
// server-side): persisted under the workspace cwd so `sessions list` from a
// fresh process still sees them.
const STATE_FILE = join(process.cwd(), ".mock-agent-sessions.json");

const sessions = new Map();
let nextSessionSeq = 1;

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (parsed && typeof parsed === "object") {
      for (const [id, state] of Object.entries(parsed)) {
        if (typeof state === "object" && state !== null) sessions.set(id, state);
      }
    }
  } catch {
    // first run in this workspace
  }
}

function saveState() {
  try {
    mkdirSync(process.cwd(), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(sessions)));
  } catch {
    // best-effort; session continuity degrades to in-memory only
  }
}

loadState();

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id, result) {
  writeFrame({ jsonrpc: "2.0", id, result });
}

function respondError(id, message, data) {
  writeFrame({ jsonrpc: "2.0", id, error: { code: -32603, message, ...(data ? { data } : {}) } });
}

function sessionUpdate(sessionId, update) {
  writeFrame({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function argvEcho() {
  return `argv=${JSON.stringify(process.argv)}`;
}

function promptText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) return prompt.map((block) => (block && typeof block.text === "string" ? block.text : "")).join("");
  return String(prompt ?? "");
}

function handlePrompt(sessionId, text) {
  const echo = `${argvEcho()}\ncwd=${process.cwd()}\nsession=${sessionId}\nreply=${text}`;
  sessionUpdate(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: echo },
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

// The queue owner inherits its stdio (xacpx spawns it with stdio "ignore"), so
// this agent's stdin can be /dev/null: when the owner dies there is NO EOF to
// end us. An idle watchdog guarantees the harness never leaks the process.
let idleTimer = setTimeout(() => process.exit(0), 60_000);
function refreshIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), 60_000);
}

rl.on("line", (line) => {
  refreshIdle();
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== "object" || typeof message.method !== "string") {
    return;
  }
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true },
          sessionCapabilities: {
            new: {},
            load: {},
            resume: {},
            close: {},
            list: {},
            cancel: {},
            setMode: {},
            setModel: {},
          },
        },
      });
      break;
    case "session/new": {
      // Fixed-width ids: acpx 0.13 uses the agent session id as the record id,
      // and xacpx's record-id parser requires >= 8 chars.
      const sessionId = `mock-${String(nextSessionSeq++).padStart(10, "0")}`;
      sessions.set(sessionId, { messages: [] });
      saveState();
      respond(id, { sessionId });
      break;
    }
    case "session/load": {
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "mock-load";
      if (!sessions.has(sessionId)) sessions.set(sessionId, { messages: [] });
      respond(id, { sessionId, messages: sessions.get(sessionId).messages });
      break;
    }
    case "session/resume": {
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "mock-resume";
      if (!sessions.has(sessionId)) sessions.set(sessionId, { messages: [] });
      saveState();
      respond(id, { sessionId, messages: sessions.get(sessionId).messages });
      break;
    }
    case "session/prompt": {
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "mock-prompt";
      const text = promptText(params?.prompt);
      handlePrompt(sessionId, text);
      respond(id, { sessionId, stopReason: "end_turn" });
      break;
    }
    case "session/cancel":
      respond(id, { cancelled: true });
      break;
    case "session/list": {
      const list = [];
      for (const [sessionId, state] of sessions) {
        list.push({ sessionId, title: state.title ?? null, updatedAt: new Date().toISOString() });
      }
      respond(id, { sessions: list, nextCursor: null });
      break;
    }
    case "session/close":
      if (typeof params?.sessionId === "string") sessions.delete(params.sessionId);
      saveState();
      respond(id, {});
      break;
    case "session/set_mode":
      respond(id, {});
      break;
    case "session/set_model":
      respond(id, {});
      break;
    case "session/set_config_option":
      respond(id, {});
      break;
    default:
      respondError(id, `mock agent: unknown method ${method}`);
  }
});

// A hung mock must never leave the harness waiting on a stray process.
process.stdin.on("end", () => process.exit(0));
