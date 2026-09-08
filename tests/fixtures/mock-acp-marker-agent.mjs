#!/usr/bin/env node
// Env-marker ACP agent for agentProcessEnv tests: on session/prompt it replies
// with the value of MARKER_VAR (default XACPX_TEST_MARKER) seen in its own
// environment, proving which child overlay the agent launched with. Never
// echoes anything else.

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const MARKER_VAR = process.env.MARKER_VAR ?? "XACPX_TEST_MARKER";

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
function respond(id, result) {
  writeFrame({ jsonrpc: "2.0", id, result });
}

let idleTimer = setTimeout(() => process.exit(0), 60_000);
function refreshIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), 60_000);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  refreshIdle();
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== "object" || typeof message.method !== "string") return;
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: { sessionCapabilities: { new: {}, load: {}, close: {}, cancel: {} } },
      });
      break;
    case "session/new":
      respond(id, { sessionId: `marker-${randomUUID()}` });
      break;
    case "session/load":
    case "session/resume":
      respond(id, {
        sessionId: typeof params?.sessionId === "string" ? params.sessionId : "marker-load",
        messages: [],
      });
      break;
    case "session/prompt": {
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "marker-prompt";
      const seen = process.env[MARKER_VAR] ?? "<unset>";
      writeFrame({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `marker=${seen}` } } },
      });
      respond(id, { sessionId, stopReason: "end_turn" });
      break;
    }
    case "session/cancel":
      respond(id, { cancelled: true });
      break;
    case "session/close":
      respond(id, {});
      break;
    case "session/list":
      respond(id, { sessions: [], nextCursor: null });
      break;
    case "session/set_mode":
    case "session/set_model":
      respond(id, {});
      break;
    case "session/set_config_option":
      respond(id, { configOptions: [] });
      break;
    default:
      break;
  }
});
