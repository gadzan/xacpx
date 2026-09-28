import { expect, test } from "bun:test";

import {
  MSG,
  RELAY_CAPABILITIES,
  parseControlPayload,
  validateInteractionResponse,
  type InteractionResponseDto,
} from "../../../../packages/relay-protocol/src/index";
import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";
import type { ChannelElicitationRequest } from "../../../src/interactions/elicitation-types";

/**
 * `RelayChannel.requestElicitation` — the PRODUCTION render path.
 *
 * Every assertion drives the real method: a channel built through its normal
 * deps, started normally, and talking to a client seam that answers the way the
 * hub answers. There is no injected `renderElicitation` and no
 * `openRelayInteraction` called by hand — those two were the halves of the old
 * split where the capability probe saw support nothing implemented, and either
 * one being present would let this file pass while production could not render.
 *
 * The one thing faked is `sendRequest`, which is exactly the network edge: the
 * frame the channel produces is captured there, re-validated with the protocol's
 * OWN validator, and answered with a frame that must also pass validation.
 */

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}

interface ClientOptions {
  capabilities?: unknown;
}

/**
 * A client seam that records what the channel sends and lets each test answer.
 *
 * `sendRequest` never settles on its own: the frame is captured and the resolution
 * is handed to the test, which is the only way to assert both "the channel opened
 * the interaction" and "it is still waiting for the human" in one sequence.
 */
function makeHarness(behavior: {
  sendRequest: (type: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown> | Promise<never>;
}) {
  const options: ClientOptions[] = [];
  const client = {
    start: () => {},
    stop: () => {},
    sendEvent: () => {},
    isReady: () => true,
    sendRequest: (type: string, payload: unknown, opts?: { timeoutMs?: number }) =>
      behavior.sendRequest(type, payload, opts),
  };
  const channel = new RelayChannel({ url: "ws://h:1", pairingToken: "t" }, {
    credentialStore: new MemoryCredentialStore(),
    createClient: (opts) => { options.push(opts); return client as never; },
  });
  return { channel, options };
}

/**
 * Start the channel and wait for its client to exist.
 *
 * start() parks on the channel's lifetime abort signal by design, so awaiting it
 * would hang every test. The probe is that start() reached its client factory,
 * which is what every assertion needs.
 */
async function startStarted(channel: RelayChannel, seen: unknown[]): Promise<void> {
  const controller = new AbortController();
  void channel.start({
    agent: { chat: async () => ({ text: "" }) },
    abortSignal: controller.signal,
    quota: {} as never,
    logger: {
      info: async () => {},
      warn: async () => {},
      error: async () => {},
      debug: async () => {},
    },
    control: {
      events: { subscribe: () => () => {} },
      listSessions: () => [],
    },
    coreVersion: "0.11.0",
  } as never);
  await waitFor(() => seen.length > 0, "channel start");
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** A core-shaped request, as `ElicitationInteractionBroker` hands it to a channel. */
function coreRequest(overrides: Partial<ChannelElicitationRequest> = {}): ChannelElicitationRequest {
  const controller = new AbortController();
  return {
    requestId: "req-channel-1",
    // A Direct Conversation turn: the shape that made this production path
    // necessary, since an ordinary-channel turn has no product row.
    chatKey: "bot:conv-1:topic-1",
    requester: { senderId: "relay:acct-9", isOwner: true },
    agent: { name: "codex" },
    message: "Which region should I deploy to?",
    mode: "form",
    fields: [
      {
        kind: "text",
        key: "region",
        title: "Region",
        required: true,
      } as ChannelElicitationRequest["fields"][number],
    ],
    expiresAt: Date.now() + 120_000,
    signal: controller.signal,
    ...overrides,
  } as ChannelElicitationRequest;
}

test("production requestElicitation opens an interaction and carries the hub's answer back", async () => {
  const outbound: Array<{ type: string; payload: unknown; timeoutMs?: number }> = [];
  let answer: ((value: unknown) => void) | null = null;
  const { channel, options } = makeHarness({
    sendRequest: (type, payload, opts) => {
      outbound.push({ type, payload, timeoutMs: opts?.timeoutMs });
      return new Promise((resolve) => { answer = resolve; });
    },
  });
  await startStarted(channel, options);

  const settled = channel.requestElicitation(coreRequest());
  await waitFor(() => outbound.length === 1, "outbound interaction request");

  // The channel really dialed the hub, on the OPEN direction.
  expect(outbound[0]!.type).toBe(MSG.interactionRequest);
  // The frame HELD UP under the protocol's own validator instead of being
  // assumed well-shaped — this is the frame the browser will be shown.
  const validated = parseControlPayload(MSG.interactionRequest, outbound[0]!.payload);
  expect(validated).not.toBeNull();
  expect(validated!.requestId).toBe("req-channel-1");
  expect(validated!.kind).toBe("elicitation");
  expect(validated!.elicitation!.fields).toHaveLength(1);
  expect(validated!.elicitation!.message).toBe("Which region should I deploy to?");
  // The transport ceiling is the window plus the shared reserve, so a slow but
  // legal answer is not cut off by a generic connector timeout.
  expect(outbound[0]!.timeoutMs).toBeGreaterThan(120_000);

  // Direct Conversation correlation, so the form lands on the right turn and the
  // web can scope it. The durable row ids are absent by design.
  expect(validated!.conversation).toEqual({ conversationId: "conv-1", topicId: "topic-1" });

  // The hub answers, with the responder identity IT stamped. The browser frame
  // carried none, so there is nothing for a client to forge here.
  const decision: InteractionResponseDto = {
    requestId: "req-channel-1",
    kind: "elicitation",
    action: "accept",
    content: { region: "us-east" },
  };
  answer!({ responded: true, response: { ...decision, responderId: "relay:acct-9" } });

  expect(await settled).toEqual({
    action: "accept",
    responderId: "relay:acct-9",
    content: { region: "us-east" },
  });
});

test("the zero-answer accept travels as null, not {}", async () => {
  const outbound: Array<{ type: string; payload: unknown }> = [];
  let answer: ((value: unknown) => void) | null = null;
  const { channel, options } = makeHarness({
    sendRequest: (type, payload) => {
      outbound.push({ type, payload });
      return new Promise((resolve) => { answer = resolve; });
    },
  });
  await startStarted(channel, options);

  // A legal all-optional form with nothing to ask. `content: null` is the ACP
  // accept; laundering it into `{}` would be a different statement.
  const settled = channel.requestElicitation(coreRequest({
    requestId: "req-zero",
    fields: [] as unknown as ChannelElicitationRequest["fields"],
  }));
  await waitFor(() => outbound.length === 1, "outbound zero-field request");
  const validated = parseControlPayload(MSG.interactionRequest, outbound[0]!.payload);
  expect(validated).not.toBeNull();
  expect(validated!.elicitation!.fields).toHaveLength(0);

  answer!({ responded: true, response: {
    requestId: "req-zero",
    kind: "elicitation",
    action: "accept",
    content: null,
    responderId: "relay:acct-9",
  } });
  expect(await settled).toEqual({
    action: "accept",
    responderId: "relay:acct-9",
    content: null,
  });
});

test("a hub-side close is a cancel, never a decline the user did not make", async () => {
  // Every transport-closed reason must come back as a cancellation. Reporting a
  // window timeout or a connector withdrawal as `decline` would tell the agent
  // the human refused to answer.
  for (const reason of ["timeout", "unsupported", "aborted", "withdrawn"]) {
    let answer: ((value: unknown) => void) | null = null;
    const { channel, options } = makeHarness({
      sendRequest: () => new Promise((resolve) => { answer = resolve; }),
    });
    await startStarted(channel, options);
    const settled = channel.requestElicitation(coreRequest({ requestId: `req-${reason}` }));
    await waitForTick();
    answer!({ responded: false, reason });
    expect(await settled).toEqual({ action: "cancel", responderId: "relay:acct-9" });
  }
});

test("a transport failure closes the interaction instead of throwing", async () => {
  // A renderer that THROWS leaves the broker waiting on a promise nobody
  // settles, which strands the turn. The channel converts it to fail-closed cancel.
  const { channel, options } = makeHarness({
    sendRequest: () => Promise.reject(new Error("instance-offline")),
  });
  await startStarted(channel, options);
  expect(await channel.requestElicitation(coreRequest())).toEqual({
    action: "cancel",
    responderId: "relay:acct-9",
  });
});

test("a malformed hub answer is a close, not a decision", async () => {
  // A decision that fails validation cannot be acted on. The identity rule is
  // NOT one of these, and deliberately so: the no-identity rule governs the
  // browser → hub frame, while what arrives here is the hub's RESULT, which
  // legitimately carries the identity the hub stamped from its own session
  // (see `parseRelayInteractionOutcome`). So the surprises that must close are
  // structural ones — an action outside the union, the wrong kind, a malformed
  // body, or a hub that stamped no identity at all.
  const surprises: unknown[] = [
    // An action this renderer never renders.
    { responded: true, response: { requestId: "req-bad", kind: "elicitation", action: "allow_always", responderId: "relay:acct-9" } },
    // The wrong decision model.
    { responded: true, response: { requestId: "req-bad", kind: "permission", action: "accept", responderId: "relay:acct-9" } },
    // The hub stamped no identity: core would refuse it anyway, so close here.
    { responded: true, response: { requestId: "req-bad", kind: "elicitation", action: "accept" } },
    // A body with no response at all.
    { responded: true },
    // Not even an object.
    "not-an-object",
  ];
  for (const surprise of surprises) {
    let answer: ((value: unknown) => void) | null = null;
    const { channel, options } = makeHarness({
      sendRequest: () => new Promise((resolve) => { answer = resolve; }),
    });
    await startStarted(channel, options);
    const settled = channel.requestElicitation(coreRequest({ requestId: "req-bad" }));
    await waitForTick();
    answer!(surprise);
    expect(await settled).toEqual({ action: "cancel", responderId: "relay:acct-9" });
  }
});

test("the request signal aborts the in-flight interaction", async () => {
  // The agent withdrew the request while the human was still deciding: the RPC
  // must not keep the interaction alive, or the form would sit on screen pointing
  // at a turn that no longer exists.
  const controller = new AbortController();
  let sent = 0;
  const { channel, options } = makeHarness({
    // Never settles: only the request signal can end this call.
    sendRequest: () => { sent += 1; return new Promise<never>(() => {}); },
  });
  await startStarted(channel, options);

  const settled = channel.requestElicitation(coreRequest({
    requestId: "req-abort",
    signal: controller.signal,
  }));
  await waitFor(() => sent === 1, "outbound request");
  controller.abort();

  expect(await settled).toEqual({ action: "cancel", responderId: "relay:acct-9" });
});

test("an unattributable request is refused rather than opened", async () => {
  // No trusted initiator means the turn has no human to answer it, and opening an
  // interaction would show a form to somebody who is not the requester.
  const outbound: Array<{ type: string; payload: unknown }> = [];
  const { channel, options } = makeHarness({
    sendRequest: (type, payload) => {
      outbound.push({ type, payload });
      return new Promise<never>(() => {});
    },
  });
  await startStarted(channel, options);

  const settled = await channel.requestElicitation(
    coreRequest({ requestId: "req-no-sender", requester: { senderId: "" } }),
  );
  expect(settled).toEqual({ action: "cancel", responderId: "" });
  // Nothing reached the hub at all.
  expect(outbound).toHaveLength(0);
});

test("the form capability is declared AND implemented (G9)", async () => {
  // Declared as a field, not as a test-only injected dependency: there is no
  // build where this channel exists but cannot render.
  const { channel } = makeHarness({ sendRequest: () => Promise.resolve({}) });
  expect(channel.elicitationModes).toEqual(["form"]);
  expect(typeof channel.requestElicitation).toBe("function");
  // And the permission half stays undeclared: no renderer exists for it yet.
  expect(channel.elicitationModes).not.toContain("url");
  expect(RELAY_CAPABILITIES.interactionPermissionV1).toBeUndefined();
});

test("the interaction capability reaches the registration handshake", async () => {
  // A capability that exists only as a constant is a constant nobody sends. The
  // connector advertises it at registration so the hub knows this instance can
  // open interactions.
  const { channel, options } = makeHarness({ sendRequest: () => Promise.resolve({}) });
  await startStarted(channel, options);

  const advertised = JSON.stringify(options[0]?.capabilities ?? []);
  expect(advertised).toContain(RELAY_CAPABILITIES.interactionElicitationFormV1);
});

async function waitForTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The hub's answer must itself pass the protocol validator — same rule both ends. */
test("the hub answer validator rejects a client-asserted identity", () => {
  // Pins the rule the connector relies on when it re-validates the answer it is
  // handed: an identity field is not merely ignored, it is refused.
  expect(validateInteractionResponse({
    requestId: "r",
    kind: "elicitation",
    action: "accept",
    responderId: "attacker",
  })).toBeNull();
  expect(validateInteractionResponse({
    requestId: "r",
    kind: "elicitation",
    action: "accept",
  })).not.toBeNull();
});
