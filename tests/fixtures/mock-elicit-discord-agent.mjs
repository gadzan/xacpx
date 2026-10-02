// Protocol-faithful ACP test agent for Discord form Elicitation.
//
// Emits a REAL `elicitation/create` over JSON-RPC, waits for the host's
// outcome, and completes the SAME prompt turn when a valid accept arrives. The
// assertion that matters is structural: the stopReason is delivered on the
// prompt that triggered the elicitation, so no second prompt was created.
//
// Modes are selected by the schema requested so one fixture covers the three
// terminal actions:
//   accept  — a plain string field, answered by the harness
//   decline — the harness declines
//   cancel  — the harness cancels
//
// This mirrors tests/fixtures/mock-elicit-cancel-agent.mjs, which established
// the pattern for ACP-level cancel scoping.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function emit(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const OUTCOME_TIMEOUT_MS = 15_000;
let promptId = null;
let promptSid = "mock-sess";

function finish(stopReason, extra = {}) {
  if (promptId === null) return;
  respond(promptId, { sessionId: promptSid, stopReason, ...extra });
  promptId = null;
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    respond(msg.id, {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        sessionCapabilities: { new: {}, load: {}, resume: {}, close: {}, list: {}, cancel: {} },
      },
    });
  } else if (msg.method === "session/new" || msg.method === "session/load" || msg.method === "session/resume") {
    respond(msg.id, { sessionId: "mock-sess" });
  } else if (msg.method === "session/prompt") {
    promptId = msg.id;
    promptSid = msg.params?.sessionId ?? "mock-sess";
    emit({
      jsonrpc: "2.0",
      id: 501,
      method: "elicitation/create",
      params: {
        sessionId: promptSid,
        mode: "form",
        message: "Which environment should I deploy to?",
        requestedSchema: {
          type: "object",
          properties: {
            env: { type: "string", title: "Environment", oneOf: [{ const: "prod", title: "Production" }, { const: "staging", title: "Staging" }] },
          },
          required: ["env"],
        },
        requestId: promptId,
      },
    });
    // A protocol-faithful agent must not hang forever if the host misbehaves:
    // close the turn so the test fails on its own assertion rather than timing
    // out at the harness level.
    setTimeout(() => finish("cancelled"), OUTCOME_TIMEOUT_MS).unref?.();
  } else if (msg.method === "$/cancel_request") {
    // Agent -> client notification; no response expected.
  } else if (msg.id === 501) {
    // The host's elicitation outcome arrives as a plain result. This fixture
    // treats any of the three ACP actions as terminal and reports which one it
    // saw, so the harness can assert the action AND the same-turn resume.
    const outcome = msg.result ?? {};
    const action = typeof outcome?.action === "string" ? outcome.action : "accept";
    const detail = action === "accept"
      ? { answered: true, env: outcome?.content?.env ?? null }
      : { answered: false };
    respond(msg.id, msg.result);
    finish("end_turn", detail);
  } else {
    respond(msg.id, {});
  }
});
