import { expect, test, mock } from "bun:test";
import {
  MSG,
  encodeEnvelope,
  webClientEnvelope,
  webEventEnvelope,
  decodeEnvelope,
  parseWebServerEvent,
} from "@ganglion/xacpx-relay-protocol";
import { handleWebClientMessage, handleConnectorTerminalEvent } from "../../../../packages/relay/src/gateway/web-inbound";
import { WebGateway } from "../../../../packages/relay/src/gateway/web-gateway";

class FakeSocket {
  sent: string[] = [];
  closeListeners: (() => void)[] = [];
  bufferedAmount = 0;
  readyState = 1;
  send(data: string) { this.sent.push(data); }
  terminate() { this.close(); }
  on(event: string, listener: () => void) { if (event === "close") this.closeListeners.push(listener); return this; }
  close() { for (const l of this.closeListeners) l(); }
}

function deps(owned: boolean, extras: Record<string, unknown> = {}) {
  const webGateway = new WebGateway();
  const sock = new FakeSocket();
  webGateway.register("a1", sock as never);
  return {
    instances: {
      getOwned: mock((_id: string, _accountId: string) => (owned ? { id: "i1" } : null)),
      listByAccount: mock((_accountId: string) => (owned ? [{ id: "i1" }] : [])),
    },
    gateway: {
      sendEvent: mock(() => true),
      sendRequest: mock(async () => ({
        terminalId: "t1",
        generation: "g1",
        attachmentId: "att-1",
        role: "controller",
        viewerCount: 1,
      })),
      isOnline: mock(() => true),
      getPublishedEndpoints: mock(() => []),
      ...extras,
    },
    webGateway,
    stateSnapshot: mock(() => ({ turns: [], usage: [], commands: [] })),
    sock,
  };
}

test("owned legacy terminal-input is forwarded as a gateway event", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", d.sock as never, encodeEnvelope(webClientEnvelope({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" })));
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls[0]).toEqual(["i1", MSG.terminalInput, { terminalId: "t1", data: "ls\n" }]);
});

test("non-owned instance is dropped (no forward)", () => {
  const d = deps(false);
  handleWebClientMessage(d as never, "a1", d.sock as never, encodeEnvelope(webClientEnvelope({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "x" })));
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("resize/close map to their gateway event types", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", d.sock as never, encodeEnvelope(webClientEnvelope({ kind: "terminal-resize", instanceId: "i1", terminalId: "t1", cols: 90, rows: 20 })));
  handleWebClientMessage(d as never, "a1", d.sock as never, encodeEnvelope(webClientEnvelope({ kind: "terminal-close", instanceId: "i1", terminalId: "t1" })));
  const calls = (d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls;
  expect(calls[0]).toEqual(["i1", MSG.terminalResize, { terminalId: "t1", cols: 90, rows: 20 }]);
  expect(calls[1]).toEqual(["i1", MSG.terminalClose, { terminalId: "t1" }]);
});

test("garbage upstream frame is ignored", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", d.sock as never, "not json");
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("terminal-open binds then sends terminal-opened with hub-stamped viewerId on the connector RPC", async () => {
  const d = deps(true);
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({
      kind: "terminal-open",
      requestId: "req-1",
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    })),
  );
  await Bun.sleep(20);

  const rpc = (d.gateway.sendRequest as ReturnType<typeof mock>).mock.calls[0];
  expect(rpc?.[0]).toBe("i1");
  expect(rpc?.[1]).toBe(MSG.terminalOpen);
  expect(rpc?.[2]).toMatchObject({
    chatKey: "relay:a1",
    sessionAlias: "demo",
    cols: 80,
    rows: 24,
  });
  expect(typeof (rpc?.[2] as { viewerId: string }).viewerId).toBe("string");

  expect(d.webGateway.socketOwnsAttachment(d.sock as never, "att-1")).toBe(true);
  const decoded = decodeEnvelope(d.sock.sent[0]!);
  expect(decoded.ok && parseWebServerEvent(decoded.envelope)).toMatchObject({
    kind: "terminal-opened",
    requestId: "req-1",
    attachmentId: "att-1",
    terminalId: "t1",
  });
});

test("instance offline open returns terminal-request-failed with instance-offline", async () => {
  const d = deps(true, { isOnline: mock(() => false) });
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({
      kind: "terminal-open",
      requestId: "req-2",
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    })),
  );
  await Bun.sleep(10);
  const decoded = decodeEnvelope(d.sock.sent[0]!);
  expect(decoded.ok && parseWebServerEvent(decoded.envelope)).toMatchObject({
    kind: "terminal-request-failed",
    requestId: "req-2",
    code: "instance-offline",
  });
  expect((d.gateway.sendRequest as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("connector reconnect mid-open retries on the new socket instead of reporting instance-offline", async () => {
  const sendRequest = mock(async () => {
    if (sendRequest.mock.calls.length === 1) throw new Error("instance-reconnected");
    return {
      terminalId: "t1",
      generation: "g1",
      attachmentId: "att-1",
      role: "controller",
      viewerCount: 1,
    };
  });
  const d = deps(true, { sendRequest, isOnline: mock(() => true) });
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({
      kind: "terminal-open",
      requestId: "req-re",
      instanceId: "i1",
      sessionAlias: "demo",
      cols: 80,
      rows: 24,
    })),
  );
  await Bun.sleep(20);
  expect(sendRequest.mock.calls.length).toBe(2);
  const decoded = decodeEnvelope(d.sock.sent[0]!);
  expect(decoded.ok && parseWebServerEvent(decoded.envelope)).toMatchObject({
    kind: "terminal-opened",
    requestId: "req-re",
    terminalId: "t1",
  });
});

test("recoverable input requires socket-owned attachment and stamps viewerId", async () => {
  const d = deps(true);
  d.webGateway.bindAttachment({
    socket: d.sock as never,
    attachmentId: "att-9",
    terminalId: "t9",
    instanceId: "i1",
  });
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({
      kind: "terminal-input",
      instanceId: "i1",
      attachmentId: "att-9",
      generation: "g9",
      dataBase64: Buffer.from("x").toString("base64"),
    })),
  );
  await Bun.sleep(5);
  const call = (d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls[0];
  expect(call?.[1]).toBe(MSG.terminalInput);
  expect(call?.[2]).toMatchObject({
    attachmentId: "att-9",
    generation: "g9",
  });
  expect(typeof (call?.[2] as { viewerId: string }).viewerId).toBe("string");
});

test("sendToAttachment drops stale viewer/attachment pairs; resource-exit fans out only bound sockets", () => {
  const gw = new WebGateway();
  const a = new FakeSocket();
  const b = new FakeSocket();
  const viewerA = gw.register("a1", a as never);
  gw.register("a1", b as never);
  gw.bindAttachment({ socket: a as never, attachmentId: "att-a", terminalId: "term", instanceId: "i1" });
  gw.bindAttachment({ socket: b as never, attachmentId: "att-b", terminalId: "term", instanceId: "i1" });

  expect(gw.sendToAttachment(viewerA, "att-a", {
    kind: "terminal-bytes",
    instanceId: "i1",
    attachmentId: "att-a",
    generation: "g",
    epoch: 1,
    sequence: 0,
    dataBase64: "YQ==",
  })).toBe(true);
  expect(gw.sendToAttachment("wrong-viewer", "att-a", {
    kind: "terminal-bytes",
    instanceId: "i1",
    attachmentId: "att-a",
    generation: "g",
    epoch: 1,
    sequence: 1,
    dataBase64: "YQ==",
  })).toBe(false);

  handleConnectorTerminalEvent(gw, "i1", MSG.terminalResourceExit, {
    terminalId: "term",
    generation: "g",
    reason: "exited",
  });
  expect(a.sent.some((s) => {
    const d = decodeEnvelope(s);
    return d.ok && parseWebServerEvent(d.envelope)?.kind === "terminal-exit";
  })).toBe(true);
  expect(b.sent.some((s) => {
    const d = decodeEnvelope(s);
    return d.ok && parseWebServerEvent(d.envelope)?.kind === "terminal-exit";
  })).toBe(true);
  expect(gw.getAttachmentBinding("att-a")).toBeUndefined();
  expect(gw.getAttachmentBinding("att-b")).toBeUndefined();
});

test("connector terminal viewer events are validated before hub fanout", () => {
  const gw = new WebGateway();
  const sock = new FakeSocket();
  const viewerId = gw.register("a1", sock as never);
  gw.bindAttachment({
    socket: sock as never,
    attachmentId: "att-a",
    terminalId: "term",
    instanceId: "i1",
  });

  // Oversized / malformed payload must be dropped at the trust boundary.
  const before = sock.sent.length;
  handleConnectorTerminalEvent(gw, "i1", MSG.terminalViewerEvent, {
    viewerId,
    attachmentId: "att-a",
    event: {
      kind: "terminal-bytes",
      generation: "g",
      epoch: 1,
      sequence: 0,
      dataBase64: "!!!not-base64!!!",
    },
  });
  expect(sock.sent.length).toBe(before);

  handleConnectorTerminalEvent(gw, "i1", MSG.terminalViewerEvent, {
    viewerId,
    attachmentId: "att-a",
    event: {
      kind: "terminal-bytes",
      generation: "g",
      epoch: 1,
      sequence: 0,
      dataBase64: Buffer.from("ok").toString("base64"),
    },
  });
  expect(sock.sent.length).toBeGreaterThan(before);
});

test("socket close clears attachments and notifies detach handler", () => {
  const detached: Array<{ attachmentId: string; viewerId: string }> = [];
  const gw = new WebGateway({
    onAttachmentDetached: (info) => detached.push(info),
  });
  const sock = new FakeSocket();
  const viewerId = gw.register("a1", sock as never);
  gw.bindAttachment({
    socket: sock as never,
    attachmentId: "att-z",
    terminalId: "tz",
    instanceId: "i1",
  });
  sock.close();
  expect(gw.getAttachmentBinding("att-z")).toBeUndefined();
  expect(detached).toEqual([{ attachmentId: "att-z", viewerId, instanceId: "i1" }]);
});

test("a subscribe frame filters ownership and installs the subscription", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", d.sock as never, encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1", "i2"] })));
  // snapshot send happens; ownership filter drops i2
  const dirDecoded = decodeEnvelope(d.sock.sent[0]!);
  expect(dirDecoded.ok && parseWebServerEvent(dirDecoded.envelope)).toMatchObject({
    kind: "agent-directory",
  });
  const snapshotDecoded = decodeEnvelope(d.sock.sent[1]!);
  expect(snapshotDecoded.ok && parseWebServerEvent(snapshotDecoded.envelope)).toMatchObject({
    kind: "state-snapshot",
    instanceId: "i1",
  });
  // THREE frames now, because the authoritative open-interaction snapshot closes
  // the boundary: replay alone is positive-only, so a browser that missed an
  // event while disconnected could not tell "I have everything" from "I am
  // missing one" and kept a form the hub had already closed.
  expect(d.sock.sent.length).toBe(3);
  const interactionDecoded = decodeEnvelope(d.sock.sent[2]!);
  expect(interactionDecoded.ok && parseWebServerEvent(interactionDecoded.envelope)).toMatchObject({
    kind: "interaction-snapshot",
    instanceId: "i1",
  });
  // The name says "installs the subscription", so assert it — by driving the real
  // gateway and observing where a control-event lands, not with a spy. `WebGateway`
  // treats a socket ABSENT from its subscription map as "receive everything", so an
  // uninstalled subscription is not a no-op: it makes the socket an account-wide
  // sink. Asserting only what subscribe sent cannot detect that, which is how the
  // deletion slipped through once.
  d.sock.sent.length = 0;
  const emitFor = (instanceId: string) => {
    d.webGateway.broadcast("a1", {
      kind: "control-event",
      instanceId,
      event: {
        type: "interaction-opened",
        chatKey: "bot:c:t",
        sessionAlias: "",
        instanceId,
        interaction: {
          requestId: "req",
          kind: "elicitation",
          conversation: { conversationId: "c", topicId: "t" },
          expiresAt: Date.now() + 60_000,
          elicitation: { mode: "form", message: "m", fields: [], agent: { name: "codex" } },
        },
      },
    } as never);
  };
  // i1 was subscribed (and owned), so it is delivered.
  emitFor("i1");
  expect(d.sock.sent).toHaveLength(1);
  // i2 was filtered out by the ownership check, so it must not be.
  d.sock.sent.length = 0;
  emitFor("i2");
  expect(d.sock.sent, "an unsubscribed instance's control-event reached the socket").toEqual([]);
});

test("in-flight terminal-open after socket close detaches the connector attachment", async () => {
  let resolveOpen!: (value: unknown) => void;
  const openGate = new Promise((resolve) => {
    resolveOpen = resolve;
  });
  const d = deps(true, { sendRequest: mock(() => openGate) });
  const rejections: unknown[] = [];
  const onRej = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRej);
  try {
    handleWebClientMessage(
      d as never,
      "a1",
      d.sock as never,
      encodeEnvelope(webClientEnvelope({
        kind: "terminal-open",
        requestId: "req-close",
        instanceId: "i1",
        sessionAlias: "demo",
        cols: 80,
        rows: 24,
      })),
    );
    await Bun.sleep(10);
    d.sock.close();
    resolveOpen({
      terminalId: "t1",
      generation: "g1",
      attachmentId: "att-1",
      role: "controller",
      viewerCount: 1,
    });
    await Bun.sleep(30);

    const detachCalls = (d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.filter(
      (call) => call[1] === MSG.terminalDetach,
    );
    expect(detachCalls).toHaveLength(1);
    expect(detachCalls[0]?.[0]).toBe("i1");
    expect(detachCalls[0]?.[2]).toMatchObject({ attachmentId: "att-1" });
    expect(d.webGateway.socketOwnsAttachment(d.sock as never, "att-1")).toBe(false);
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRej);
  }
});

void webEventEnvelope;

// The authoritative open-set snapshot, and the reconnect boundary it closes.
//
// `interaction-opened` is a one-shot push and `interaction-closed` is its only
// negative, so a browser that was disconnected while an interaction was answered
// elsewhere receives NEITHER: no open to miss, no close to observe. Subscribe
// replays the still-open set, but a replay is positive-only — it cannot say
// "that is all of them", so the client cannot tell "I have everything" from "I am
// missing an event" and keeps a form the hub has already closed.
//
// `control.interaction.snapshot` is that statement, and these three cases are the
// contract it must satisfy.

/** An interaction the fake registry holds open, shaped like the real entry. */
function openInteraction(requestId: string, over: Record<string, unknown> = {}) {
  return {
    requestId,
    instanceId: "i1",
    accountId: "a1",
    kind: "elicitation" as const,
    expiresAt: Date.now() + 60_000,
    chatKey: "bot:c1:t1",
    sessionAlias: "review",
    conversation: { conversationId: "c1", topicId: "t1" },
    elicitation: { mode: "form" as const, message: "Which region?", fields: [], agent: { name: "codex" } },
    ...over,
  };
}

/** Wire-shape entries, i.e. what `parseWebServerEvent` must accept. */
function entryFor(entry: ReturnType<typeof openInteraction>) {
  return {
    chatKey: entry.chatKey,
    sessionAlias: entry.sessionAlias,
    interaction: {
      requestId: entry.requestId,
      kind: entry.kind,
      conversation: entry.conversation,
      expiresAt: entry.expiresAt,
      elicitation: entry.elicitation,
    },
  };
}

/** A `deps` whose registry holds the given open interactions for i1. */
function depsWithOpen(open: ReturnType<typeof openInteraction>[]) {
  const d = deps(true);
  return {
    ...d,
    interactions: {
      listForInstance: mock((instanceId: string) => (instanceId === "i1" ? open : [])),
      listForAccount: mock(() => open),
      get: mock(() => null),
    },
  };
}

/** Decode only the interaction-snapshot frame from a socket's sends. */
function snapshotFrames(sock: FakeSocket) {
  return sock.sent
    .map((raw) => decodeEnvelope(raw))
    .filter((d) => d.ok)
    .map((d) => parseWebServerEvent(d.envelope))
    .filter((e) => e !== null && e.kind === "interaction-snapshot");
}

test("a snapshot declares the authoritative open set for the instance it names", () => {
  const d = depsWithOpen([openInteraction("req-web-1"), openInteraction("req-web-2")]);
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1"] })),
  );
  const snapshots = snapshotFrames(d.sock);
  expect(snapshots).toHaveLength(1);
  const ids = snapshots[0]!.interactions.map((e) => e.interaction.requestId).sort();
  expect(ids).toEqual(["req-web-1", "req-web-2"]);
});

test("a snapshot OMITS an interaction that resolved, which is the negative evidence", async () => {
  // The case that decides whether the reconnect boundary actually closes.
  //
  // Before the snapshot existed, the hub's subscribe path replayed only what it
  // still held and sent no statement about anything else. A tab that was away
  // while `req-web-2` was answered elsewhere therefore kept it locally and
  // displayed it indefinitely — the user could click it and only then learn, from
  // a 409, that the request was gone.
  //
  // The snapshot's OMISSION is the signal: an entry present locally and absent
  // here is closed on the server. The replay still carries the live one.
  const d = depsWithOpen([openInteraction("req-web-1")]);
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1"] })),
  );
  const snapshots = snapshotFrames(d.sock);
  expect(snapshots[0]!.interactions.map((e) => e.interaction.requestId)).toEqual(["req-web-1"]);
  expect(snapshots[0]!.interactions.map((e) => e.interaction.requestId)).not.toContain("req-web-2");
});

test("a snapshot is scoped to ONE instance and never merges another's forms", () => {
  // The store is account-wide, so a browser must be able to reconcile i1 without
  // concluding anything about i2. An instance-scoped snapshot is what makes that
  // safe: an omissive signal is only meaningful for the instance it covers.
  const d = depsWithOpen([openInteraction("req-web-1")]);
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1", "i2"] })),
  );
  // i2 is dropped by the ownership filter entirely, so exactly one snapshot and it
  // is i1's.
  const snapshots = snapshotFrames(d.sock);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]!.instanceId).toBe("i1");
});

test("a snapshot entry carries the routing a cold-open needs", () => {
  // The client must not have to invent a chatKey or sessionAlias to open a form it
  // has never seen: those decide where the answer is routed, and a guess there is
  // exactly the kind of thing the interaction contract forbids.
  const d = depsWithOpen([openInteraction("req-web-1")]);
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1"] })),
  );
  const entry = snapshotFrames(d.sock)[0]!.interactions[0]!;
  expect(entry.chatKey).toBe("bot:c1:t1");
  expect(entry.sessionAlias).toBe("review");
  expect(entry.interaction.requestId).toBe("req-web-1");
  // And the entry is the SAME shape the replay sends, so a client can treat the
  // two identically.
  const replayed = d.sock.sent
    .map((raw) => decodeEnvelope(raw))
    .filter((x) => x.ok)
    .map((x) => parseWebServerEvent(x.envelope))
    .find((e) => e !== null && e.kind === "control-event"
      && (e.event as { type?: string }).type === "interaction-opened") as {
    event: { interaction: { requestId: string }; chatKey: string };
  } | undefined;
  expect(replayed?.event.interaction.requestId).toBe(entry.interaction.requestId);
  expect(replayed?.event.chatKey).toBe(entry.chatKey);
});

test("a malformed snapshot is refused rather than parsed leniently", () => {
  // An unvalidated snapshot would let a reconnect resurrect a form the hub should
  // never have accepted: every entry goes through the same field rules the live
  // open path enforces, and a frame that violates them is dropped whole.
  const bad = {
    kind: "interaction-snapshot" as const,
    instanceId: "i1",
    interactions: [{
      chatKey: "bot:c1:t1",
      sessionAlias: "review",
      interaction: {
        requestId: "req-web-1",
        kind: "elicitation" as const,
        // An over-long field key: legal nowhere, so the whole frame goes.
        elicitation: {
          mode: "form" as const,
          message: "m",
          fields: [{ kind: "text", key: "x".repeat(129), title: "T", required: true }],
          agent: { name: "codex" },
        },
      },
    }],
  };
  expect(parseWebServerEvent(webEventEnvelope(bad))).toBeNull();
  // And a well-formed one still parses, so the rejection is about the payload
  // rather than the frame kind being unknown.
  expect(parseWebServerEvent(webEventEnvelope({
    kind: "interaction-snapshot" as const,
    instanceId: "i1",
    interactions: [],
  }))).not.toBeNull();
});

// ORDERING INVARIANT: the subscribe branch sends all of its frames in one turn.
//
// The snapshot's omissive reconciliation is only safe if interaction opens that
// happened before the capture are IN the snapshot, and opens that happen after it
// are carried by a live event that lands AFTER the snapshot. Both halves of that
// are automatic in Node only while `setSubscription -> capture -> send` runs in a
// single synchronous turn.
//
// An `await` inserted before the capture (a DB lookup, metrics, a permission
// re-check) opens a window where an interaction can open, be omitted from the
// snapshot, AND have its live event land first — so the client retires a form the
// hub still holds. Repairing that needs a revision/sequence fence, so this test
// fails loudly the moment anyone reaches for an `await` in that branch.
test("subscribe sends every frame in ONE synchronous turn", () => {
  const d = depsWithOpen([openInteraction("req-web-1")]);
  // No `await` on the call, and none inside the assertion chain. If the handler
  // yields anywhere between installing the subscription and sending the snapshot,
  // the frames below simply will not be there yet.
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1"] })),
  );
  // The directory, the state snapshot, the replay of the still-open form, and the
  // snapshot itself — count is the replay's business; what matters is that the
  // snapshot is LAST, because an omission is only meaningful after the client is
  // guaranteed to have seen the positive half.
  expect(d.sock.sent.length).toBeGreaterThanOrEqual(3);
  const kinds = d.sock.sent
    .map((raw) => decodeEnvelope(raw))
    .filter((x) => x.ok)
    .map((x) => parseWebServerEvent(x.envelope))
    .map((e) => (e === null ? null : e.kind));
  expect(kinds[0]).toBe("agent-directory");
  expect(kinds[1]).toBe("state-snapshot");
  // Snapshot AFTER the state snapshot and AFTER every replay: an omission is only
  // meaningful once the client is guaranteed to have seen the positive half,
  // otherwise it would retire an interaction that merely had not been replayed.
  expect(kinds[kinds.length - 1]).toBe("interaction-snapshot");
  // Every frame sits between the directory and the snapshot.
  expect(kinds.every((k) => k === "agent-directory" || k === "state-snapshot"
    || k === "interaction-snapshot" || k === "control-event")).toBe(true);
});

test("an interaction opened AFTER subscribe lands after the snapshot", () => {
  // The other half of the invariant, asserted so that "the snapshot is complete"
  // cannot be read as "no live event may ever follow it". Order guarantees the
  // follow-up open is delivered after, so the client sees it as an addition
  // rather than a contradiction.
  const d = depsWithOpen([openInteraction("req-web-1")]);
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1"] })),
  );
  const snapshotIndex = d.sock.sent
    .map((raw) => decodeEnvelope(raw))
    .filter((x) => x.ok)
    .map((x) => parseWebServerEvent(x.envelope))
    .findIndex((e) => e !== null && e.kind === "interaction-snapshot");

  // A NEW interaction opens after the subscribe has completed.
  handleWebClientMessage(
    d as never,
    "a1",
    d.sock as never,
    encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1"] })),
  );
  const secondSnapshotIndex = d.sock.sent
    .map((raw) => decodeEnvelope(raw))
    .filter((x) => x.ok)
    .map((x) => parseWebServerEvent(x.envelope))
    .findIndex((e, i) => e !== null && e.kind === "interaction-snapshot" && i > snapshotIndex);
  expect(secondSnapshotIndex).toBeGreaterThan(snapshotIndex);
});

// SUBSCRIPTION ROUTING — a subscribe frame must actually install the subscription.
//
// This was a real P1: the subscribe branch filtered `instanceIds` and sent the
// directory, state snapshot, replay and interaction snapshot, but never called
// `setSubscription()`. `WebGateway` treats a socket ABSENT from its subscription
// map as "receive EVERY control-event", so the fresh socket became an account-wide
// sink — until something else happened to install a set.
//
// That silently defeats the snapshot boundary. A browser subscribing ["i1"] would
// receive instance i2's live `interaction-opened`, store it account-wide, and then
// never receive an i2 interaction-snapshot (it only subscribes i1), so the form
// could not be retired on reconnect. The stale-form bug this whole change fixes
// would reappear for exactly the instances the subscription was meant to exclude.
//
// Driven through the REAL `WebGateway` on purpose: the assertion is about which
// frames reach the socket, not that a particular method was called, so deleting
// the `setSubscription` call again turns this red from outside.

test("a subscribe frame installs the instance subscription on the real gateway", () => {
  const webGateway = new WebGateway();
  const sock = new FakeSocket();
  webGateway.register("a1", sock as never);
  const d = {
    instances: {
      getOwned: mock((id: string) => (id === "i1" || id === "i2" ? { id } : null)),
      listByAccount: mock(() => [{ id: "i1" }, { id: "i2" }]),
    },
    gateway: {
      sendEvent: mock(() => true),
      isOnline: mock(() => true),
      getPublishedEndpoints: mock(() => []),
    },
    webGateway,
    stateSnapshot: mock(() => ({ turns: [], usage: [], commands: [] })),
    interactions: {
      listForInstance: mock(() => []),
      listForAccount: mock(() => []),
      get: mock(() => null),
    },
    sock,
  };

  handleWebClientMessage(
    d as never,
    "a1",
    sock as never,
    encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1"] })),
  );

  const kind = (raw: string) => {
    const decoded = decodeEnvelope(raw);
    if (!decoded.ok) return null;
    const e = parseWebServerEvent(decoded.envelope) as { kind?: string } | null;
    return e?.kind ?? null;
  };

  // Sanity: only i1 was snapshotted. i2 was not even reached.
  expect(sock.sent.map(kind)).toEqual(["agent-directory", "state-snapshot", "interaction-snapshot"]);

  // The routing assertion. A control-event for the UNSUBSCRIBED instance must not
  // reach this socket, and one for the subscribed instance must.
  sock.sent.length = 0;
  webGateway.broadcast("a1", {
    kind: "control-event",
    instanceId: "i2",
    event: {
      type: "interaction-opened",
      chatKey: "bot:c2:t2",
      sessionAlias: "",
      instanceId: "i2",
      interaction: {
        requestId: "req-i2",
        kind: "elicitation",
        conversation: { conversationId: "c2", topicId: "t2" },
        expiresAt: Date.now() + 60_000,
        elicitation: { mode: "form", message: "m", fields: [], agent: { name: "codex" } },
      },
    },
  } as never);
  expect(sock.sent, "an unsubscribed instance's control-event reached the socket").toEqual([]);

  webGateway.broadcast("a1", {
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "interaction-opened",
      chatKey: "bot:c1:t1",
      sessionAlias: "review",
      instanceId: "i1",
      interaction: {
        requestId: "req-i1",
        kind: "elicitation",
        conversation: { conversationId: "c1", topicId: "t1" },
        expiresAt: Date.now() + 60_000,
        elicitation: { mode: "form", message: "m", fields: [], agent: { name: "codex" } },
      },
    },
  } as never);
  expect(sock.sent, "a subscribed instance's control-event was dropped").toHaveLength(1);
});

test("a re-subscribe narrows an existing socket's instance set", () => {
  // `setSubscription` is a full-set replace, not an additive union. A browser that
  // narrows from ["i1","i2"] to ["i1"] must stop receiving i2's live events, or the
  // snapshot's instance fence is bypassed from the other direction.
  const webGateway = new WebGateway();
  const sock = new FakeSocket();
  webGateway.register("a1", sock as never);
  const d = {
    instances: {
      getOwned: mock((id: string) => (id === "i1" || id === "i2" ? { id } : null)),
      listByAccount: mock(() => [{ id: "i1" }, { id: "i2" }]),
    },
    gateway: {
      sendEvent: mock(() => true),
      isOnline: mock(() => true),
      getPublishedEndpoints: mock(() => []),
    },
    webGateway,
    stateSnapshot: mock(() => ({ turns: [], usage: [], commands: [] })),
    interactions: {
      listForInstance: mock(() => []),
      listForAccount: mock(() => []),
      get: mock(() => null),
    },
    sock,
  };

  handleWebClientMessage(
    d as never,
    "a1",
    sock as never,
    encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1", "i2"] })),
  );
  sock.sent.length = 0;

  const emitFor = (instanceId: string) => {
    webGateway.broadcast("a1", {
      kind: "control-event",
      instanceId,
      event: {
        type: "interaction-opened",
        chatKey: "bot:c:t",
        sessionAlias: "",
        instanceId,
        interaction: {
          requestId: "req",
          kind: "elicitation",
          conversation: { conversationId: "c", topicId: "t" },
          expiresAt: Date.now() + 60_000,
          elicitation: { mode: "form", message: "m", fields: [], agent: { name: "codex" } },
        },
      },
    } as never);
  };

  emitFor("i2");
  emitFor("i1");
  expect(sock.sent).toHaveLength(2);

  // Narrow to just i1.
  handleWebClientMessage(
    d as never,
    "a1",
    sock as never,
    encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1"] })),
  );
  sock.sent.length = 0;
  emitFor("i2");
  expect(sock.sent, "a re-subscribe did not narrow the instance set").toEqual([]);
  emitFor("i1");
  expect(sock.sent).toHaveLength(1);
});
