import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function emit(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function elicit(id, sid, message, requestId) {
  emit({ jsonrpc: "2.0", id, method: "elicitation/create", params: { sessionId: sid, mode: "form", message, requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, ...(requestId !== undefined ? { requestId } : {}) } });
}
let promptId = null;
let promptSid = "mock-sess";
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    respond(msg.id, { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true, promptCapabilities: {}, sessionCapabilities: { new: {}, load: {}, resume: {}, close: {}, list: {}, cancel: {} } } });
  } else if (msg.method === "session/new" || msg.method === "session/load" || msg.method === "session/resume") {
    respond(msg.id, { sessionId: "mock-sess" });
  } else if (msg.method === "session/prompt") {
    promptId = msg.id;
    promptSid = msg.params?.sessionId ?? "mock-sess";
    // FIRST elicitation: scoped to this prompt so the agent can withdraw JUST
    // it with `$/cancel_request` while the turn stays alive.
    elicit(401, promptSid, "q1", promptId);
    // Cancel after a real delay. acpx dispatches the handler synchronously from
    // the JSON-RPC callback, so a same-batch notification loses that race —
    // the request is cancelled before the host ever sees it, which is not the
    // case under test. 250ms is long enough for the worker→engine→host chain
    // to be live and short enough to keep the test fast.
    setTimeout(() => {
      emit({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 401 } });
    }, 250).unref?.();
  } else if (msg.id === 401) {
    // The withdrawn request's reply arrives from the host. The turn is still
    // alive, so ask again on the SAME prompt — that second ask is the assertion
    // that cancellation was request-scoped, not turn-scoped.
    elicit(402, promptSid, "q2", promptId);
  } else if (msg.id === 402) {
    respond(msg.id, msg.result);
    respond(promptId, { sessionId: promptSid, stopReason: "end_turn" });
  } else if (msg.method === "$/cancel_request") {
    // Agent -> client notification; no response expected.
  } else respond(msg.id, {});
});
