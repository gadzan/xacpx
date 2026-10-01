import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import type {
  InteractionRequestDto,
  WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";

const mockRpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    rpc: (instanceId: string, type: string, payload?: unknown) => mockRpc(instanceId, type, payload),
  },
}));

import { useDirectBotsStore } from "../stores/direct-bots";

/**
 * The interaction slice of the Direct Bot store.
 *
 * These pin the decisions that are the browser's to make and nobody else's: that
 * answers stay local until submit, that the three terminal actions stay
 * distinct, and that a form is never left answerable after its window closes.
 */
describe("useDirectBotsStore interactions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockRpc.mockReset();
  });

  function formRequest(overrides: Partial<InteractionRequestDto> = {}): InteractionRequestDto {
    return {
      requestId: "req-1",
      kind: "elicitation",
      expiresAt: Date.now() + 60_000,
      elicitation: {
        mode: "form",
        agent: { name: "codex" },
        message: "Which environment?",
        fields: [
          {
            kind: "single-select",
            key: "env",
            title: "Environment",
            required: true,
            options: [
              { value: "prod", label: "Production" },
              { value: "staging", label: "Staging" },
            ],
          },
          { kind: "text", key: "note", title: "Note", required: false },
        ],
      },
      // Direct Bot topic correlation. A form with no correlation belongs to an
      // ordinary channel turn, which has no topic — so it renders only on the
      // account-wide surface and never inside a topic the viewer is reading.
      conversation: { conversationId: "c1", topicId: "t1" },
      ...overrides,
    };
  }

  function openedEvent(
    request: InteractionRequestDto,
    instanceId = "inst_1",
  ): WebServerEvent {
    return {
      kind: "control-event",
      instanceId,
      event: {
        type: "interaction-opened",
        chatKey: "bot:c1:t1",
        sessionAlias: "brt_hidden",
        // On the EVENT, not only the envelope: the hub stamps the opening
        // connector's instance on the control event, and the store reads that to
        // route the answer back. The envelope's is the broadcast's own.
        instanceId,
        interaction: request,
      },
    } as unknown as WebServerEvent;
  }

  function closedEvent(
    requestId: string,
    reason: "resolved" | "withdrawn" | "expired",
    instanceId = "inst_1",
    action?: "accept" | "decline" | "cancel",
  ): WebServerEvent {
    return {
      kind: "control-event",
      instanceId,
      event: {
        type: "interaction-closed",
        chatKey: "bot:c1:t1",
        instanceId,
        requestId,
        reason,
        // The action a resolve carried, so a tab that did not click knows.
        ...(action !== undefined ? { action } : {}),
      },
    } as unknown as WebServerEvent;
  }

  it("an opened form is stored with EMPTY answers", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    expect(store.pendingInteraction).not.toBeNull();
    // Nothing is pre-filled, so a default cannot be submitted unlooked-at.
    expect(store.pendingInteraction!.answers).toEqual({});
    expect(store.pendingInteraction!.request.requestId).toBe("req-1");
  });

  it("a permission interaction is ignored — no renderer exists for it", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent({
      requestId: "req-p",
      kind: "permission",
      expiresAt: Date.now() + 60_000,
      permission: { title: "Run shell", availableOutcomes: ["allow_once"] },
    }));
    expect(store.pendingInteraction).toBeNull();
  });

  it("an already-expired form is ignored rather than shown", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest({ expiresAt: Date.now() - 1 })));
    expect(store.pendingInteraction).toBeNull();
  });

  it("an unknown field key is refused, so the hub's field list stays authoritative", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("not_a_field", "x");
    expect(store.pendingInteraction!.answers).toEqual({});
  });

  it("a known field key is recorded", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "prod");
    store.setInteractionAnswer("note", "ship it");
    expect(store.pendingInteraction!.answers).toEqual({ env: "prod", note: "ship it" });
  });

  it("accept sends the collected answers", async () => {
    const store = useDirectBotsStore();
    mockRpc.mockResolvedValue({ ok: true });
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "staging");
    store.setInteractionAnswer("note", "go");
    await store.submitInteraction("accept");
    expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.interaction.respond", {
      requestId: "req-1",
      kind: "elicitation",
      action: "accept",
      content: { env: "staging", note: "go" },
    });
    // Still submitting: the RPC is an ack, and the form's terminal state arrives
    // on `interaction-closed`. Declaring an outcome here would pre-empt the hub.
    expect(store.pendingInteraction!.outcome).toBeNull();
    expect(store.pendingInteraction!.submitting).toBe(true);
    expect(store.pendingInteraction!.errorCode).toBeNull();
  });

  it("interaction-closed is what resolves the form", async () => {
    // The browser does not learn its own decision from the submit's result — the
    // hub resolves the interaction for every tab, including this one.
    const store = useDirectBotsStore();
    mockRpc.mockResolvedValue({ ok: true });
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "staging");
    await store.submitInteraction("accept");
    store.applyEvent(closedEvent("req-1", "resolved"));
    expect(store.pendingInteraction!.outcome).toBe("accepted");
    expect(store.pendingInteraction!.submitting).toBe(false);
  });

  it("accept with no answers at all sends a null content, not an empty object", async () => {
    const store = useDirectBotsStore();
    mockRpc.mockResolvedValue({ responded: true, response: { requestId: "req-1", kind: "elicitation", action: "accept" } });
    // An ALL-OPTIONAL form: nothing is required, so an empty submit is legal and
    // must be expressed as `null` (ACP's "accept with no answers") rather than
    // `{}`, which would be a different statement.
    store.applyEvent(openedEvent(formRequest({
      elicitation: {
        mode: "form",
        agent: { name: "codex" },
        message: "Anything?",
        fields: [
          {
            kind: "single-select",
            key: "any",
            title: "Anything",
            required: false,
            options: [{ value: "a", label: "A" }],
          },
        ],
      },
    })));
    await store.submitInteraction("accept");
    expect(mockRpc).toHaveBeenCalled();
    const payload = mockRpc.mock.calls[0]![2] as { content: unknown };
    expect(payload.content).toBeNull();
  });

  it("accept with a required field unanswered is refused locally, before any RPC", async () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    await store.submitInteraction("accept");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(store.pendingInteraction!.errorCode).toBe("submitFailed");
    // The form is still open so the user can fill it in.
    expect(store.pendingInteraction!.outcome).toBeNull();
  });

  it("decline sends no content and is a distinct action from cancel", async () => {
    const store = useDirectBotsStore();
    mockRpc.mockResolvedValue({ ok: true });
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "prod");
    await store.declineInteraction();
    expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.interaction.respond", {
      requestId: "req-1",
      kind: "elicitation",
      action: "decline",
    });
    // What the browser concludes is the close, but the hub's frame now carries
    // the action the human actually chose — so a tab that did not click still
    // reports "declined" rather than guessing "accepted".
    store.applyEvent(closedEvent("req-1", "resolved", "inst_1", "decline"));
    expect(store.pendingInteraction!.outcome).toBe("declined");
  });

  it("cancel is reported as its own outcome", async () => {
    const store = useDirectBotsStore();
    mockRpc.mockResolvedValue({ ok: true });
    store.applyEvent(openedEvent(formRequest()));
    await store.cancelInteraction();
    const payload = mockRpc.mock.calls[0]![2] as { action: string };
    expect(payload.action).toBe("cancel");
    store.applyEvent(closedEvent("req-1", "resolved", "inst_1", "cancel"));
    expect(store.pendingInteraction!.outcome).toBe("cancelled");
  });

  it("a withdrawn interaction is never reported as a user decline", async () => {
    // The turn went away or the window closed: the user did not refuse anything,
    // and collapsing this into `declined` would misreport who decided what.
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.applyEvent(closedEvent("req-1", "withdrawn"));
    expect(store.pendingInteraction!.outcome).toBe("withdrawn");
  });

  it("an expired interaction is reported as cancelled, not as a user action", async () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.applyEvent(closedEvent("req-1", "expired"));
    expect(store.pendingInteraction!.outcome).toBe("cancelled");
  });

  it("a transport failure leaves the form open with a bounded code", async () => {
    const store = useDirectBotsStore();
    mockRpc.mockRejectedValue(new Error("network down"));
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "prod");
    await store.submitInteraction("accept");
    // Retryable: the interaction may still be answerable, so the form stays up.
    expect(store.pendingInteraction!.errorCode).toBe("submitFailed");
    expect(store.pendingInteraction!.outcome).toBeNull();
  });

  it("a gone interaction is reported as gone, not as a retryable failure", async () => {
    // The window closed between the click and the answer: there is nothing to
    // retry, and the form must say so instead of staying up forever. The hub
    // reports this as an error payload, which the transport surfaces as a
    // rejected RPC — the same shape any transport failure produces.
    const store = useDirectBotsStore();
    mockRpc.mockResolvedValue({ error: { code: "interaction-gone", message: "gone" } });
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "prod");
    await store.submitInteraction("accept");
    expect(store.pendingInteraction!.errorCode).toBe("interactionGone");
    expect(store.pendingInteraction!.outcome).toBeNull();
  });

  it("a closed interaction is mapped onto a user-visible outcome", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.applyEvent(closedEvent("req-1", "resolved"));
    expect(store.pendingInteraction!.outcome).toBe("accepted");
  });

  it("a withdrawn interaction is NOT reported as a user cancellation", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.applyEvent(closedEvent("req-1", "withdrawn"));
    // The hub closed it, nobody decided: "cancelled" would claim the user chose it.
    expect(store.pendingInteraction!.outcome).toBe("withdrawn");
  });

  it("an expired interaction is reported as closed, not declined", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.applyEvent(closedEvent("req-1", "expired"));
    expect(store.pendingInteraction!.outcome).toBe("cancelled");
  });

  it("a close for a different requestId does not dismiss the open form", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.applyEvent(closedEvent("some-other-request", "resolved"));
    expect(store.pendingInteraction!.outcome).toBeNull();
  });

  it("a required field named like a prototype member is NOT pre-answered", () => {
    // The bug this pins. Answers were a plain object literal, so a required field
    // keyed "constructor"/"toString"/"valueOf" read a value that Object.prototype
    // always provides and the form looked answered: Submit was allowed, the hub
    // closed the interaction, and core then rejected an answer the user never
    // gave. That ordering cannot be undone.
    //
    // Asserted by ANSWERING that field and checking the map stays a data property
    // it owns, plus the required check treating an untouched map as unanswered.
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest({
      elicitation: {
        mode: "form",
        agent: { name: "codex" },
        message: "Pick.",
        fields: [
          { kind: "text", key: "constructor", title: "Constructor", required: true },
          { kind: "text", key: "valueOf", title: "ValueOf", required: true },
        ],
      },
    })));

    // Untouched: NOT answerable, even though both keys exist on the prototype.
    expect(store.pendingInteraction!.answers).toBeDefined();
    const untouched = Object.keys(store.pendingInteraction!.answers);
    expect(untouched).toHaveLength(0);

    // Answering the first makes it a real own data property.
    store.setInteractionAnswer("constructor", "typed-by-user");
    const answers = store.pendingInteraction!.answers;
    expect(Object.keys(answers)).toEqual(["constructor"]);
    expect(answers["constructor"]).toBe("typed-by-user");
    // The second is still unanswered, so the form is not answerable yet.
    expect(Object.hasOwn(answers, "valueOf")).toBe(false);
  });

  it("a real __proto__ answer survives as its own data property", () => {
    // The other half: assigning through the prototype chain dropped the answer
    // silently, so a completed form arrived empty. The answer map is
    // null-prototype, so this key becomes a real own property and round-trips.
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest({
      elicitation: {
        mode: "form",
        agent: { name: "codex" },
        message: "Pick.",
        fields: [{ kind: "text", key: "__proto__", title: "Proto", required: true }],
      },
    })));
    store.setInteractionAnswer("__proto__", "user-value");
    const answers = store.pendingInteraction!.answers;
    expect(Object.hasOwn(answers, "__proto__")).toBe(true);
    expect(answers["__proto__"]).toBe("user-value");
  });

  it("a second opened form does not drop the first", () => {
    // M1's cancellation is request-scoped, so the same turn can hold more than
    // one pending interaction. Dropping the first here used to leave it with no
    // UI while the hub and core still considered it open — an agent waiting on an
    // answer the user has no way to give, until it timed out.
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.applyEvent(openedEvent(formRequest({ requestId: "req-2" })));
    // The newest is what is shown, which is deterministic and matches the order
    // the hub emitted.
    expect(store.pendingInteraction!.request.requestId).toBe("req-2");
    // But the first is NOT gone: closing the visible one reveals it rather than
    // leaving the slot empty.
    store.applyEvent(closedEvent("req-2", "resolved"));
    expect(store.pendingInteraction!.request.requestId).toBe("req-1");
  });

  it("an open form on another topic is stored but not displayed", () => {
    // The two halves that used to be conflated. Dropping the event entirely was
    // permanent — the form was unreachable for the rest of its window. Rendering
    // it everywhere was worse: the user answered a question belonging to a
    // different conversation. So it is kept, and scoped on visibility.
    const store = useDirectBotsStore();
    store.activeConversationId = "c1";
    store.activeTopicId = "t1";
    store.applyEvent(openedEvent(formRequest({ conversation: { conversationId: "c2", topicId: "t2" } })));
    // Stored: the switch below finds it.
    store.activeConversationId = "c2";
    store.activeTopicId = "t2";
    expect(store.pendingInteraction!.request.requestId).toBe("req-1");
    // And not displayed while viewing the other topic's context.
    store.activeConversationId = "c1";
    store.activeTopicId = "t1";
    expect(store.pendingInteraction).toBeNull();
  });

  it("a submit after the window closed is refused rather than sent", async () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "prod");
    // Simulate the window closing while the form was open.
    store.pendingInteraction!.request.expiresAt = Date.now() - 1;
    await store.submitInteraction("accept");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(store.pendingInteraction!.errorCode).toBe("interactionGone");
  });

  it("reconcile keeps a form whose turn is still live", async () => {
    const store = useDirectBotsStore();
    mockRpc.mockResolvedValue({ run: { id: "run_1", state: "waiting-human", conversationId: "c1", topicId: "t1", requestMessageId: "m1", mode: "explicit", profileRevision: 1, createdAt: "now", memberTurns: [] } });
    store.applyEvent(openedEvent(formRequest()));
    store.instanceId = "inst_1";
    store.selectedBotId = "bot_1";
    store.activeConversationId = "c1";
    store.activeTopicId = "t1";
    store.activeRun = {
      id: "run_1",
      conversationId: "c1",
      topicId: "t1",
      requestMessageId: "m1",
      requestId: "rq1",
      mode: "explicit",
      state: "waiting-human",
      profileRevision: 1,
      createdAt: "now",
    };
    await store.reconcileOnReconnect();
    await flushPromises();
    // The turn is still waiting on this human, so the form is still answerable.
    expect(store.pendingInteraction!.outcome).toBeNull();
  });

  it("reconcile drops a form whose turn is gone", async () => {
    const store = useDirectBotsStore();
    mockRpc.mockResolvedValue({ run: { id: "run_1", state: "completed", conversationId: "c1", topicId: "t1", requestMessageId: "m1", mode: "explicit", profileRevision: 1, createdAt: "now", memberTurns: [] } });
    store.applyEvent(openedEvent(formRequest()));
    store.instanceId = "inst_1";
    store.selectedBotId = "bot_1";
    store.activeConversationId = "c1";
    store.activeTopicId = "t1";
    store.activeRun = {
      id: "run_1",
      conversationId: "c1",
      topicId: "t1",
      requestMessageId: "m1",
      requestId: "rq1",
      mode: "explicit",
      state: "waiting-human",
      profileRevision: 1,
      createdAt: "now",
    };
    await store.reconcileOnReconnect();
    await flushPromises();
    // The turn completed while disconnected: a form with no live turn cannot be
    // answered, so it is withdrawn rather than left inviting a submit.
    expect(store.pendingInteraction!.outcome).toBe("withdrawn");
  });

  it("a replayed interaction-opened keeps the user's draft while taking the hub's request", () => {
    // A reconnect replays every still-open interaction, so the same requestId
    // arrives a second time as an authoritative re-announcement. Rebuilding the
    // entry wiped `answers`, and the user lost everything typed since the
    // original open — through no action of their own — right when the network
    // was at its least reliable.
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest({ expiresAt: Date.now() + 60_000 })));
    store.setInteractionAnswer("env", "prod");
    store.setInteractionAnswer("note", "ready to ship");

    // The replay carries a later deadline and a different message: the hub is
    // authoritative about anything the user cannot author.
    const replayedExpiresAt = Date.now() + 120_000;
    store.applyEvent(openedEvent(
      formRequest({
        expiresAt: replayedExpiresAt,
        elicitation: {
          mode: "form",
          agent: { name: "codex" },
          message: "Which environment (revised)?",
          fields: formRequest().elicitation!.fields,
        },
      }),
      // The event is also authoritative about the connector, not the local copy.
      "inst_2",
    ));

    expect(store.pendingInteraction!.request.requestId).toBe("req-1");
    expect(store.pendingInteraction!.request.expiresAt).toBe(replayedExpiresAt);
    expect(store.pendingInteraction!.request.elicitation!.message).toBe("Which environment (revised)?");
    // The draft survived, keyed by the field it belongs to.
    expect(store.pendingInteraction!.answers).toEqual({ env: "prod", note: "ready to ship" });
    // A still-open replay is not a resolution, and the connector that opened it
    // comes from the replayed event.
    expect(store.pendingInteraction!.outcome).toBeNull();
    expect(store.pendingInteraction!.instanceId).toBe("inst_2");
  });

  it("a cold open still starts with no answers at all", () => {
    // The control for the test above: preservation is scoped to a requestId that
    // is already held. A first-time open must not inherit anything, or a default
    // could be submitted without the user looking at it.
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    expect(Object.keys(store.pendingInteraction!.answers)).toHaveLength(0);
  });

  it("a replay preserves a submit error the user has not yet acted on", async () => {
    // The failure is still on screen and unresolved: clearing it on replay would
    // make a retried submit look like a first attempt.
    const store = useDirectBotsStore();
    mockRpc.mockImplementation(() => Promise.reject(new Error("network down")));
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "prod");
    // Network dropped mid-submit: the interaction is still open server-side, so
    // the reconnect replays it.
    await store.submitInteraction("accept");
    store.applyEvent(openedEvent(formRequest({ expiresAt: Date.now() + 90_000 })));
    expect(store.pendingInteraction!.errorCode).toBe("submitFailed");
  });

  it("a replay does not leave a form claiming a submit is still in flight", async () => {
    // The submit's ack was lost with the connection: the request may have landed
    // or may never have been sent, and nothing on this tab can tell. Leaving
    // `submitting` true would make the form silently refuse the user's next
    // click, because a submit is fenced on it.
    const store = useDirectBotsStore();
    // An RPC that never settles, so the submit stays in flight.
    mockRpc.mockImplementation(() => new Promise<never>(() => {}));
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "prod");
    void store.submitInteraction("accept");
    await flushPromises();
    expect(store.pendingInteraction!.submitting).toBe(true);
    store.applyEvent(openedEvent(formRequest({ expiresAt: Date.now() + 90_000 })));
    expect(store.pendingInteraction!.submitting).toBe(false);
  });

test("a form opened by ANOTHER INSTANCE is not rendered in this instance's topic view", () => {
  // Conversation and Topic ids are not globally unique: two daemons that copied
  // state, restored a backup, or were cloned produce the same `c1/t1`.
  //
  // The account-wide subscription in DashboardView means instance B's
  // `interaction-opened` reaches this store, and matching on topic alone made it
  // in scope for A's pane. Submit routes to the state's own `instanceId`, so the
  // user would read B's question in A's UI and deliver the answer to B.
  //
  // Same family as the cross-topic finding, with the third scope key missing.
  const store = useDirectBotsStore();
  store.instanceId = "inst-A";
  store.selectedBotId = "bot_1";
  store.activeConversationId = "c1";
  store.activeTopicId = "t1";
  // Same conversation AND topic, different originating instance.
  store.applyEvent(openedEvent(formRequest(), "inst-B"));
  expect(store.pendingInteraction).toBeNull();
});

test("a form opened by the SELECTED instance is rendered", () => {
  // The control for the test above: identical conversation and topic, but the
  // instance matches what is on screen, so it is in scope. Without this the
  // previous test would pass for the wrong reason (nothing ever renders).
  const store = useDirectBotsStore();
  store.instanceId = "inst-A";
  store.selectedBotId = "bot_1";
  store.activeConversationId = "c1";
  store.activeTopicId = "t1";
  store.applyEvent(openedEvent(formRequest(), "inst-A"));
  expect(store.pendingInteraction).not.toBeNull();
  // And the answer routes back to the instance that opened it.
  expect(store.pendingInteraction!.instanceId).toBe("inst-A");
});

test("an account-wide surface shows no instance's form preferentially", () => {
  // With no instance selected there is no instance to be wrong about, so the
  // instance key scopes nothing out. Both instances' frames remain reachable.
  const store = useDirectBotsStore();
  store.selectedBotId = "bot_1";
  store.applyEvent(openedEvent(formRequest(), "inst-B"));
  expect(store.pendingInteraction).not.toBeNull();
});

test("a form with no conversation correlation is NOT rendered inside a topic view", () => {
  // An uncorrelated frame is an ordinary channel turn. It has no topic, so there
  // is nothing that proves it belongs to the topic the viewer happens to be
  // reading — and rendering it there invites answering a different conversation.
  // Scoped OUT, which is fail-closed: the form is unreachable on that surface
  // rather than reachable on the wrong one.
  const store = useDirectBotsStore();
  store.instanceId = "inst_1";
  store.selectedBotId = "bot_1";
  store.activeConversationId = "c1";
  store.activeTopicId = "t1";
  store.applyEvent(openedEvent(formRequest({ conversation: undefined })));
  expect(store.pendingInteraction).toBeNull();
});

test("a correlated form IS rendered inside its own topic view", () => {
  const store = useDirectBotsStore();
  store.instanceId = "inst_1";
  store.selectedBotId = "bot_1";
  store.activeConversationId = "c1";
  store.activeTopicId = "t1";
  store.applyEvent(openedEvent(formRequest()));
  expect(store.pendingInteraction).not.toBeNull();
});

test("an uncorrelated form is reachable on the account-wide surface", () => {
  // Scoped out of a topic, not dropped: with no topic selected there is no topic
  // to be wrong about, so the frame stays answerable where its turn came from.
  const store = useDirectBotsStore();
  store.instanceId = "inst_1";
  store.selectedBotId = "bot_1";
  store.applyEvent(openedEvent(formRequest({ conversation: undefined })));
  expect(store.pendingInteraction).not.toBeNull();
});

});
