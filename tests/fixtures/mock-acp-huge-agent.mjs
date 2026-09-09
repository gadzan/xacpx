#!/usr/bin/env node
// Minimal ACP agent for incoming-message-limit tests: on session/prompt it
// emits ONE agent_message_chunk of HUGE_BYTES (default 1 MiB) then completes.
// Unlike mock-acp-agent.mjs it never echoes the prompt, so the inbound frame
// size is controlled without sending a giant prompt first.

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const SIZE = Number(process.env.HUGE_BYTES ?? String(1024 * 1024));

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
      respond(id, { sessionId: `huge-${randomUUID()}` });
      break;
    case "session/load":
    case "session/resume":
      respond(id, {
        sessionId: typeof params?.sessionId === "string" ? params.sessionId : "huge-load",
        messages: [],
      });
      break;
    case "session/prompt": {
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "huge-prompt";
      writeFrame({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "z".repeat(SIZE) } } },
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
    default:
      break;
  }
});
