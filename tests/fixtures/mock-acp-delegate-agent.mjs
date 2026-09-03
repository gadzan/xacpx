#!/usr/bin/env node
// ACP mock agent that on prompt "delegate:<text>" emits a tool_call for delegate_request
// via the Runtime's MCP routing, then completes. Otherwise echoes like the base mock.

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const sessions = new Map();
let nextSessionSeq = 1;

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
function respond(id, result) {
  writeFrame({ jsonrpc: "2.0", id, result });
}
function sessionUpdate(sessionId, update) {
  writeFrame({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let idleTimer = setTimeout(() => process.exit(0), 10_000);
function refreshIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), 10_000);
}

rl.on("line", (line) => {
  refreshIdle();
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.method !== "string") return;
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true },
          sessionCapabilities: { new: {}, load: {}, resume: {}, close: {}, list: {}, cancel: {}, setMode: {}, setModel: {} },
        },
      });
      break;
    case "session/new": {
      const sessionId = `mock-${randomUUID()}`;
      sessions.set(sessionId, { messages: [] });
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
      respond(id, { sessionId });
      break;
    }
    case "session/prompt": {
      const sessionId = params?.sessionId;
      const prompt = params?.prompt?.[0]?.text ?? params?.text ?? "";
      // If prompt is delegate:xxx, emit a tool_call for delegate_request
      // The Runtime (acpx/runtime) will route this to the xacpx mcp-server.
      // We simulate the agent's tool use by sending a session/update with tool_call.
      if (typeof prompt === "string" && prompt.startsWith("delegate:")) {
        const taskText = prompt.slice(9);
        const toolCallId = `call-${randomUUID()}`;
        // Emit tool_call update
        sessionUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "delegate_request",
          kind: "execute",
          status: "pending",
          rawInput: { targetAgent: "codex", task: taskText, workingDirectory: "/tmp/backend" },
        });
        // Simulate tool result after a short delay, then final message
        setTimeout(() => {
          sessionUpdate(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "delegate_request",
            kind: "execute",
            status: "completed",
            rawOutput: { ok: true },
          });
          sessionUpdate(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `delegated:${taskText}` },
          });
          respond(id, { stopReason: "end_turn" });
        }, 100);
      } else {
        // Echo for other prompts
        const echo = `reply=${prompt}`;
        sessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: echo },
        });
        respond(id, { stopReason: "end_turn" });
      }
      break;
    }
    case "session/cancel":
      respond(id, {});
      break;
    default:
      respond(id, {});
      break;
  }
});

process.stdin.on("end", () => process.exit(0));
