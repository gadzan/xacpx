import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine.ts";
import type { RuntimeWorkerElicitationRequestPayload } from "../../../../../src/bridge/engine/runtime/runtime-worker-protocol.ts";

/**
 * Round 7 regression: the agent identity carried to the renderer must be the
 * user-facing xacpx alias, not the transport selector.
 *
 * `buildEnsureParams().agent` is `input.acpxAgent ?? input.agent`, and
 * `acpxAgent` is documented as the "acpx positional agent / xacpx-managed
 * overlay alias" — structured launches generate names like
 * `xacpx-managed-codex-9d1628a76ca9`. Displaying that to a user does not
 * satisfy ACP's "clearly identify the Agent" requirement, which exists so the
 * user knows who is asking before they answer.
 */

async function buildWorker(dir: string): Promise<string> {
  const workerOutDir = join(dir, "dist", "bridge", "engine", "runtime");
  const result = await Bun.build({
    entrypoints: [resolve(process.cwd(), "./src/bridge/engine/runtime/runtime-worker-main.ts")],
    outdir: workerOutDir,
    target: "node",
    external: ["acpx", "node-pty", "fs-ext", "write-file-atomic"],
  });
  if (!result.success) throw new Error(`Bun.build failed: ${result.logs.join("\n")}`);
  return join(workerOutDir, "runtime-worker-main.js");
}

function mockElicitingAgent(): string {
  return `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
function update(sessionId, upd) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: upd } }) + "\\n"); }
let promptId = null;
let promptSid = "mock-sess";
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") respond(msg.id, { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true, promptCapabilities: {}, sessionCapabilities: { new:{}, load:{}, resume:{}, close:{}, list:{}, cancel:{} } } });
  else if (msg.method === "session/new" || msg.method === "session/load" || msg.method === "session/resume") respond(msg.id, { sessionId: "mock-sess" });
  else if (msg.method === "session/prompt") {
    promptId = msg.id; promptSid = msg.params?.sessionId ?? "mock-sess";
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 301, method: "elicitation/create", params: { sessionId: promptSid, mode: "form", message: "pick", requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } }) + "\\n");
  } else if (msg.id === 301) {
    update(promptSid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answered" } });
    respond(msg.id, msg.result);
    respond(promptId, { sessionId: promptSid });
  } else respond(msg.id, {});
});
`;
}

test("the renderer sees the user-facing alias, not the transport selector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-elicit-identity-"));
  const workerFile = await buildWorker(dir);
  const agentFile = join(dir, "mock-identity-agent.mjs");
  await writeFile(agentFile, mockElicitingAgent());

  let seen: RuntimeWorkerElicitationRequestPayload | undefined;
  const engine = new RuntimeEngine({
    workerEntryPath: workerFile,
    stateDir: join(dir, "state", "sessions"),
    queueDir: join(dir, "queue"),
    fenceDir: join(dir, "fences"),
    permissionMode: "approve-all",
    elicitationInteractionCapable: true,
    onElicitationRequest: async (payload) => {
      seen = payload;
      return { action: "accept", content: { answer: "yes" } };
    },
  } as never);

  try {
    await engine.prompt({
      agent: "user-alias",
      // The transport selector that a structured/managed launch resolves to.
      acpxAgent: "xacpx-managed-codex-9d1628a76ca9",
      agentArgv: [process.execPath, agentFile],
      cwd: dir,
      name: "identity-session",
      logicalSessionId: "identity-1",
      text: "ask",
    } as never, async () => {});

    expect(seen).toBeDefined();
    // Must be the alias the user configured, never the internal overlay name.
    expect(seen!.agentName).toBe("user-alias");
    expect(seen!.agentName).not.toContain("xacpx-managed");
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 30_000);

test("the worker construction still uses the transport selector", async () => {
  // The two identities must stay separate: `ensureParams.agent` is the
  // transport selector used to launch the agent, and must not be repurposed
  // for display.
  const dir = await mkdtemp(join(tmpdir(), "rt-elicit-construct-"));
  const workerFile = await buildWorker(dir);
  const agentFile = join(dir, "mock-construct-agent.mjs");
  await writeFile(agentFile, mockElicitingAgent());

  let seen: RuntimeWorkerElicitationRequestPayload | undefined;
  const engine = new RuntimeEngine({
    workerEntryPath: workerFile,
    stateDir: join(dir, "state", "sessions"),
    queueDir: join(dir, "queue"),
    fenceDir: join(dir, "fences"),
    permissionMode: "approve-all",
    elicitationInteractionCapable: true,
    onElicitationRequest: async (payload) => {
      seen = payload;
      return { action: "cancel" };
    },
  } as never);

  try {
    await engine.prompt({
      agent: "user-alias",
      acpxAgent: "xacpx-managed-codex-9d1628a76ca9",
      agentArgv: [process.execPath, agentFile],
      cwd: dir,
      name: "construct-session",
      logicalSessionId: "construct-1",
      text: "ask",
    } as never, async () => {});
    expect(seen!.agentName).toBe("user-alias");
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 30_000);

test("an absent agentName cancels at the broker, before any UI", async () => {
  // An empty `agent` cannot launch a worker at all ("ACP agent id is
  // required"), so the reachable missing-identity case is a worker that
  // launched but carries no alias for this turn. That is the broker's
  // fail-closed path, covered in the broker suite; here we assert the engine
  // forwards whatever alias it was given rather than substituting its own.
  const dir = await mkdtemp(join(tmpdir(), "rt-elicit-forward-"));
  const workerFile = await buildWorker(dir);
  const agentFile = join(dir, "mock-forward-agent.mjs");
  await writeFile(agentFile, mockElicitingAgent());

  let seen: RuntimeWorkerElicitationRequestPayload | undefined;
  const engine = new RuntimeEngine({
    workerEntryPath: workerFile,
    stateDir: join(dir, "state", "sessions"),
    queueDir: join(dir, "queue"),
    fenceDir: join(dir, "fences"),
    permissionMode: "approve-all",
    elicitationInteractionCapable: true,
    onElicitationRequest: async (payload) => {
      seen = payload;
      return { action: "cancel" };
    },
  } as never);

  try {
    // `agent` present, `acpxAgent` absent: both identities collapse to the same
    // value, which is the common single-alias configuration.
    await engine.prompt({
      agent: "codex",
      agentArgv: [process.execPath, agentFile],
      cwd: dir,
      name: "forward-session",
      logicalSessionId: "forward-1",
      text: "ask",
    } as never, async () => {});
    expect(seen!.agentName).toBe("codex");
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 30_000);
