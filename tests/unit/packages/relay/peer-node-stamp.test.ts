// A peer Agent message is the ingress that pre-writes its own inbound row: the
// core fires turn-started (carrying the node id) BEFORE the router emits the
// agent-message that appends the row. The hub therefore reconciles a turn whose
// prompt is already present and, without a stamp there, the row never gets a
// node id — so the Web offers no per-message fork entry on it.
import { expect, test } from "bun:test";
import { MSG, RELAY_PROTOCOL_VERSION } from "../../../../packages/relay-protocol/src/index";
import { createRelayRuntime } from "../../../../packages/relay/src/server";

async function seeded() {
  const runtime = await createRelayRuntime(":memory:");
  runtime.db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u", "t"]);
  runtime.db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
  return runtime;
}

const peerMessage = {
  kind: "agent_message" as const,
  direction: "received" as const,
  messageId: "msg_peer_1",
  conversationId: "conv_1",
  peer: { handle: "agent:n1:sender", displayName: "Sender", agent: "codex" },
  content: "schema changed",
  createdAt: 1_000,
  status: "delivered" as const,
};

test("a peer turn's pre-written inbound row carries the node id", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });

  // Real core order: turn-started first (no `prompt` — a peer turn's text is not
  // in turnStarted), then the router appends the inbound row.
  fire({
    type: "turn-started",
    chatKey: "relay:agent-message:backend",
    sessionAlias: "backend",
    promptRequestId: "msg_peer_1",
    nodeId: "node-peer",
    peerOrigin: {
      requestMessageId: "msg_peer_1",
      completion: "none",
      source: { nodeId: "n1", endpointId: "sender" },
      target: { nodeId: "n1", endpointId: "target" },
    },
  });
  fire({ type: "agent-message", chatKey: "relay:agent-message:backend", sessionAlias: "backend", message: peerMessage });
  fire({ type: "turn-output", chatKey: "relay:agent-message:backend", sessionAlias: "backend", chunk: "ack" });
  fire({ type: "turn-finished", chatKey: "relay:agent-message:backend", sessionAlias: "backend", ok: true });

  const rows = runtime.messages.listBySession("a1", "i1", "backend").messages;
  const inbound = rows.find((row) => row.direction === "in");
  expect(inbound?.text).toBe("schema changed");
  expect(inbound?.nodeId).toBe("node-peer");
  runtime.close();
});

test("a peer turn queued behind a busy target still stamps its row", async () => {
  const runtime = await seeded();
  const fire = (event: unknown) => runtime.gateway["deps"].onEvent!("i1", "a1", {
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: { event },
  });

  // The target was busy, so the message row was written at delivery time and the
  // turn only starts later — its turn-started arrives with the row already there.
  fire({ type: "agent-message", chatKey: "relay:agent-message:backend", sessionAlias: "backend", message: peerMessage });
  fire({
    type: "turn-started",
    chatKey: "relay:agent-message:backend",
    sessionAlias: "backend",
    promptRequestId: "msg_peer_1",
    nodeId: "node-queued",
    peerOrigin: {
      requestMessageId: "msg_peer_1",
      completion: "none",
      source: { nodeId: "n1", endpointId: "sender" },
      target: { nodeId: "n1", endpointId: "target" },
    },
  });
  fire({ type: "turn-output", chatKey: "relay:agent-message:backend", sessionAlias: "backend", chunk: "ack" });
  fire({ type: "turn-finished", chatKey: "relay:agent-message:backend", sessionAlias: "backend", ok: true });

  const rows = runtime.messages.listBySession("a1", "i1", "backend").messages;
  expect(rows.find((row) => row.direction === "in")?.nodeId).toBe("node-queued");
  runtime.close();
});
