#!/usr/bin/env node
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
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
      sessions.set(sessionId, { messages: [], mcpServers: params?.mcpServers ?? [] });
      respond(id, { sessionId });
      break;
    }
    case "session/load": {
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "mock-load";
      if (!sessions.has(sessionId)) sessions.set(sessionId, { messages: [], mcpServers: params?.mcpServers ?? [] });
      else if (params?.mcpServers) sessions.get(sessionId).mcpServers = params.mcpServers;
      respond(id, { sessionId, messages: sessions.get(sessionId).messages });
      break;
    }
    case "session/resume": {
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "mock-resume";
      if (!sessions.has(sessionId)) sessions.set(sessionId, { messages: [], mcpServers: params?.mcpServers ?? [] });
      else if (params?.mcpServers) sessions.get(sessionId).mcpServers = params.mcpServers;
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
        let errMsg = null;
        let res = null;
        try {
          const sessData = sessions.get(sessionId);
          const mcpServers = sessData?.mcpServers ?? [];
          const mcpServerSpec = mcpServers.find((s) => s.name === "xacpx") ?? mcpServers[0];
          if (!mcpServerSpec) {
            throw new Error(`No MCP servers provided in session. sessData: ${JSON.stringify(sessData)}`);
          }
          const envObj = { ...process.env };
          if (Array.isArray(mcpServerSpec.env)) {
            for (const e of mcpServerSpec.env) {
              if (e && typeof e.name === "string") {
                envObj[e.name] = e.value;
              }
            }
          } else if (mcpServerSpec.env && typeof mcpServerSpec.env === "object") {
            Object.assign(envObj, mcpServerSpec.env);
          }
          let stdioErr = "";
          const transport = new StdioClientTransport({
            command: mcpServerSpec.command,
            args: mcpServerSpec.args,
            env: envObj,
          });
          transport.stderr?.on("data", (chunk) => {
            stdioErr += chunk.toString();
          });
          const client = new Client({ name: "mock-delegate-agent-mcp-client", version: "1.0.0" });
          await client.connect(transport);
          res = await client.request(
            {
              method: "tools/call",
              params: {
                name: "delegate_request",
                arguments: {
                  targetAgent: "codex",
                  task: taskText,
                  workingDirectory: "/tmp/backend",
                },
              },
            },
            CallToolResultSchema,
          );
          await client.close();
          sessionUpdate(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "delegate_request",
            kind: "execute",
            status: "completed",
            rawOutput: res,
          });
        } catch (e) {
          errMsg = `${e instanceof Error ? (e.stack || e.message) : String(e)} | STDERR: ${stdioErr}`;
          process.stderr.write(`AGENT delegate err: ${errMsg}\n`);
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
          content: { type: "text", text: errMsg ? `ERR:${errMsg}` : `delegated:${taskText}:res:${JSON.stringify(res)}` },
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
