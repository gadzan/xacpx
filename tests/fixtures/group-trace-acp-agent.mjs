#!/usr/bin/env node
// ACP v1 adapter for verify-group-trace.mjs. All activity traverses the real
// acpx transport and SessionTurnRunner; the audit file records provider starts.
import { appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const member = option("--member");
const audit = option("--audit");
const recoveryGate = option("--recovery-gate");
if (!member || !audit || !recoveryGate) throw new Error("missing fixture arguments");
const pending = new Map();
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const update = (sessionId, value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const textOf = (prompt) => typeof prompt === "string" ? prompt : (prompt ?? []).map((part) => part.text ?? "").join("");
const record = (value) => appendFileSync(audit, `${JSON.stringify({ member, pid: process.pid, ...value })}\n`);
record({ kind: "process-start" });

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialize") {
    reply(id, { protocolVersion: 1, authMethods: [], agentInfo: { name: "group-trace-proof", version: "1.0.0" }, agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true }, sessionCapabilities: { resume: {}, list: {}, close: {} } } });
  } else if (method === "session/new") {
    reply(id, { sessionId: `trace-${member}-${randomUUID()}` });
  } else if (method === "session/load" || method === "session/resume") {
    reply(id, { sessionId: params.sessionId, messages: [] });
  } else if (method === "session/list") {
    reply(id, { sessions: [] });
  } else if (method === "session/prompt") {
    const sessionId = params.sessionId;
    const text = textOf(params.prompt);
    // A recovery may re-dispatch a still-held turn. The gate closes it
    // cleanly so a restarted daemon does not keep a held run running forever.
    // TRACE_HOLD_QUEUED ignores the gate: the verifier cancels that hold
    // explicitly through the public run-cancel RPC.
    if (text.includes("TRACE_HOLD_QUEUED")) {
      record({ kind: "prompt", sessionId, text });
      const queuedPrefix = `trace-${member}`;
      update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `${queuedPrefix}:public-thought` } });
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: `${queuedPrefix}-tool`, title: `${queuedPrefix}:inspect`, kind: "read", status: "pending", rawInput: { path: `${queuedPrefix}.txt` } });
      pending.set(id, { sessionId });
      return;
    }
    if (text.includes("TRACE_HOLD") && existsSync(recoveryGate)) {
      record({ kind: "gate-reject", sessionId, text });
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: "verification recovery gate" } });
      return;
    }
    record({ kind: "prompt", sessionId, text });
    const prefix = `trace-${member}`;
    // Immediate public activity: thought, replace-latest plan and the pending
    // tool frame, so the runner has observable progress before the staged
    // tool_call_update. Separate frames by time so progress is observable
    // through the real runner.
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `${prefix}:public-thought` } });
    update(sessionId, { sessionUpdate: "plan", entries: [{ content: `${prefix}:inspect`, status: "in_progress", priority: "high" }] });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: `${prefix}-tool`, title: `${prefix}:inspect`, kind: "read", status: "pending", rawInput: { path: `${prefix}.txt` } });
    const timer = setTimeout(() => {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: `${prefix}-tool`, status: "in_progress", content: [{ type: "content", content: { type: "text", text: `${prefix}:progress` } }] });
      if (text.includes("TRACE_HOLD")) {
        pending.set(id, { sessionId });
        return;
      }
      setTimeout(() => {
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: `${prefix}-tool`, status: "completed", rawOutput: { result: `${prefix}:success` }, content: [{ type: "content", content: { type: "text", text: `${prefix}:success` } }] });
        update(sessionId, { sessionUpdate: "plan", entries: [{ content: `${prefix}:inspect`, status: "completed", priority: "high" }] });
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${prefix}:final-answer` } });
        record({ kind: "final", sessionId, text });
        reply(id, { sessionId, stopReason: "end_turn" });
        pending.delete(id);
      }, 150);
    }, 150);
    pending.set(id, { sessionId, timer });
  } else if (method === "session/cancel") {
    for (const [requestId, item] of pending) {
      if (item.sessionId !== params.sessionId) continue;
      clearTimeout(item.timer);
      reply(requestId, { sessionId: item.sessionId, stopReason: "cancelled" });
      pending.delete(requestId);
    }
    if (id !== undefined) reply(id, {});
  } else if (method === "authenticate" || method === "session/close" || method === "session/set_mode" || method === "session/set_model" || method === "session/set_config_option") {
    if (id !== undefined) reply(id, {});
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported fixture method: ${method}` } });
  }
});
lines.on("close", () => process.exit(0));
