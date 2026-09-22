import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createXacpxRuntimeAdapter,
  type XacpxElicitationContext,
  type XacpxElicitationRequest,
  type XacpxElicitationResponse,
  type XacpxRuntimeSessionHandle,
} from "../../../../../src/bridge/engine/runtime/runtime-adapter";

const INITIALIZE_RESPONSE = {
  protocolVersion: 1,
  authMethods: [],
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: {},
    sessionCapabilities: { new: {}, load: {}, resume: {}, close: {}, list: {}, cancel: {} },
  },
};

/** Shared mock-agent prelude: initialize, session lifecycle, event plumbing. */
const AGENT_PRELUDE = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
function update(sessionId, upd) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: upd } }) + "\\n"); }
const INIT = ${JSON.stringify(INITIALIZE_RESPONSE)};
let promptId = null;
let promptSid = "mock-sess";
`;

/** Mock agent that issues ONE elicitation, records the response, ends the turn. */
function singleElicitationAgent(respFile: string, acpRequestId: number | string): string {
  return `${AGENT_PRELUDE}
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") respond(msg.id, INIT);
  else if (msg.method === "session/new" || msg.method === "session/load" || msg.method === "session/resume") respond(msg.id, { sessionId: "mock-sess" });
  else if (msg.method === "session/prompt") {
    promptId = msg.id; promptSid = msg.params?.sessionId ?? "mock-sess";
    update(promptSid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "asking" } });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: ${JSON.stringify(acpRequestId)}, method: "elicitation/create", params: { sessionId: promptSid, mode: "form", message: "pick", requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } }) + "\\n");
  } else if (msg.id === ${JSON.stringify(acpRequestId)}) {
    writeFileSync(${JSON.stringify(respFile)}, JSON.stringify(msg));
    update(promptSid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answered" } });
    respond(promptId, { sessionId: promptSid });
  } else if (msg.id !== undefined) respond(msg.id, {});
});
`.replace(
    'const rl = createInterface',
    'import { writeFileSync } from "node:fs";\nconst rl = createInterface',
  );
}

/** Mock agent that issues THREE SEQUENTIAL elicitations, recording each response. */
function threeElicitationAgent(seenFile: string): string {
  return `${AGENT_PRELUDE}
import { writeFileSync } from "node:fs";
const seen = [];
let nextId = 1;
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") respond(msg.id, INIT);
  else if (msg.method === "session/new" || msg.method === "session/load" || msg.method === "session/resume") respond(msg.id, { sessionId: "mock-sess" });
  else if (msg.method === "session/prompt") {
    promptId = msg.id; promptSid = msg.params?.sessionId ?? "mock-sess";
    update(promptSid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "asking" } });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: nextId, method: "elicitation/create", params: { sessionId: promptSid, mode: "form", message: "pick", requestedSchema: { type: "object", properties: { answer: { type: "string" } } } } }) + "\\n");
  } else if (msg.id === nextId) {
    seen.push({ id: msg.id, result: msg.result });
    writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify(seen));
    if (seen.length < 3) {
      nextId += 1;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: nextId, method: "elicitation/create", params: { sessionId: promptSid, mode: "form", message: "pick", requestedSchema: { type: "object", properties: { answer: { type: "string" } } } } }) + "\\n");
      return;
    }
    update(promptSid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all-answered" } });
    respond(promptId, { sessionId: promptSid });
  } else if (msg.id !== undefined) respond(msg.id, {});
});
`;
}

/**
 * Drive one turn through the real acpx runtime + a mock ACP agent that issues
 * one elicitation. Asserts the handler saw the exact upstream identity and
 * that the agent received the mapped ACP response.
 */
async function driveTurn(options: {
  sessionKey: string;
  agentSource: string;
  modes: readonly ("form" | "url")[];
  onElicitation: (
    request: XacpxElicitationRequest,
    context: XacpxElicitationContext,
  ) => Promise<XacpxElicitationResponse>;
  run: () => Promise<void>;
}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `xacpx-elicit-${options.sessionKey}-`));
  const stateDir = join(dir, "state", "sessions");
  const agentFile = join(dir, "mock-agent.mjs");
  await writeFile(agentFile, options.agentSource);
  const adapter = createXacpxRuntimeAdapter({
    stateDir,
    permissionMode: "approve-all",
    agentOverrides: { mock: [process.execPath, agentFile] },
    elicitationModes: options.modes,
  });
  let handle: XacpxRuntimeSessionHandle | undefined;
  try {
    handle = await adapter.ensure({ sessionKey: options.sessionKey, agent: "mock", cwd: dir });
    const turn = adapter.startTurn({
      handle,
      text: "go",
      onElicitation: options.onElicitation,
    });
    await turn.promptStarted;
    for await (const _event of turn.events) {
      // Drain until the prompt settles.
    }
    const result = await turn.result;
    expect(result.status).toBe("completed");
    await options.run();
  } finally {
    // Close the SAME handle (no second ensure): a fresh ensure would spawn
    // another agent child that keeps the temp dir locked on Windows.
    if (handle) await adapter.close(handle, { discardPersistentState: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test("adapter preserves the exact upstream requestId and abort signal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-elicit-identity-"));
  const respFile = join(dir, "elicit-resp.json");
  const acpRequestId = 4242;
  await driveTurn({
    sessionKey: "elicit-identity",
    agentSource: singleElicitationAgent(respFile, acpRequestId),
    modes: ["form"],
    onElicitation: async (request, context) => {
      // The exact JSON-RPC id the agent used reaches the xacpx handler.
      expect(context.requestId).toBe(acpRequestId);
      expect(context.signal.aborted).toBe(false);
      // The original ACP request body survives unmodified.
      expect(request).toMatchObject({
        mode: "form",
        message: "pick",
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      });
      return { action: "accept", content: { answer: "yes" } };
    },
    run: async () => {
      // The agent receives the pinned ACP accept shape with its content.
      const seen = JSON.parse(await Bun.file(respFile).text());
      expect(seen.result).toEqual({ action: "accept", content: { answer: "yes" } });
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  });
});

test("adapter preserves a string JSON-RPC id verbatim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-elicit-stringid-"));
  const respFile = join(dir, "elicit-resp.json");
  await driveTurn({
    sessionKey: "elicit-string-id",
    agentSource: singleElicitationAgent(respFile, "req-abc-1"),
    modes: ["form"],
    onElicitation: async (_request, context) => {
      expect(context.requestId).toBe("req-abc-1");
      return { action: "cancel" };
    },
    run: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  });
});

test("adapter maps accept content, decline, and cancel distinctly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-elicit-actions-"));
  const seenFile = join(dir, "seen.json");
  const responses: XacpxElicitationResponse[] = [
    { action: "accept", content: { answer: "alpha" } },
    { action: "decline" },
    { action: "cancel" },
  ];
  await driveTurn({
    sessionKey: "elicit-actions",
    agentSource: threeElicitationAgent(seenFile),
    modes: ["form"],
    onElicitation: async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra elicitation");
      return next;
    },
    run: async () => {
      const seen = JSON.parse(await Bun.file(seenFile).text());
      expect(seen).toEqual([
        { id: 1, result: { action: "accept", content: { answer: "alpha" } } },
        { id: 2, result: { action: "decline" } },
        { id: 3, result: { action: "cancel" } },
      ]);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  });
});

test("adapter advertises no elicitation capability without configured modes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-elicit-modes-"));
  const respFile = join(dir, "never.json");
  await driveTurn({
    sessionKey: "elicit-nomodes",
    agentSource: singleElicitationAgent(respFile, 77),
    // Empty: the daemon has no form-capable channel.
    modes: [],
    onElicitation: async () => ({ action: "accept", content: { answer: "yes" } }),
    run: async () => {
      // Upstream refuses the elicitation locally (unsupported mode): the
      // xacpx handler is never invoked and the agent is told it is
      // unsupported. The recorded response is therefore NOT the mapped
      // accept — and this run() returning at all proves the handler was
      // skipped, because `modes: []` means no handler was registered
      // upstream.
      const seen = JSON.parse(await Bun.file(respFile).text());
      expect(seen.result.action).not.toBe("accept");
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  });
});
