#!/usr/bin/env node
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const sessions = new Map();

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

rl.on("line", async (line) => {
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
      if (typeof prompt === "string" && prompt.startsWith("delegate:")) {
        const taskText = prompt.slice(9);
        const toolCallId = `call-${randomUUID()}`;
        sessionUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "delegate_request",
          kind: "execute",
          status: "pending",
          rawInput: { targetAgent: "codex", task: taskText, workingDirectory: "/tmp/backend" },
        });
        try {
          const { OrchestrationClient } = await import(join(process.cwd(), "src/orchestration/orchestration-client.ts"));
          const { resolveDefaultOrchestrationEndpoint } = await import(join(process.cwd(), "src/mcp/resolve-endpoint.ts"));
          const endpoint = resolveDefaultOrchestrationEndpoint(process.env, process.platform);
          process.stderr.write(`AGENT endpoint: ${endpoint.path} env: ${process.env.XACPX_ORCHESTRATION_SOCKET}\n`);
          const client = new OrchestrationClient(endpoint);
          const res = await client.requestDelegate({
            coordinatorSession: process.env.XACPX_COORDINATOR_SESSION ?? "coord:real-worker",
            sourceHandle: process.env.XACPX_SOURCE_HANDLE ?? "src-real",
            sourceKind: "coordinator",
            workspace: "backend",
            targetAgent: "codex",
            task: taskText,
            cwd: "/tmp/backend",
            workingDirectory: "/tmp/backend",
          });
          process.stderr.write(`AGENT delegate res: ${JSON.stringify(res)}\n`);
          sessionUpdate(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "delegate_request",
            kind: "execute",
            status: "completed",
            rawOutput: { ok: true },
          });
        } catch (e) {
          process.stderr.write(`AGENT delegate err: ${e instanceof Error ? e.stack : String(e)}\n`);
          sessionUpdate(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "delegate_request",
            kind: "execute",
            status: "failed",
            rawOutput: { error: e instanceof Error ? e.message : String(e) },
          });
        }
        sessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `delegated:${taskText}` },
        });
        respond(id, { stopReason: "end_turn" });
      } else {
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
