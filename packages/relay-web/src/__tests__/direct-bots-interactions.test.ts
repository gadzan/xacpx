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
        interaction: request,
      },
    } as unknown as WebServerEvent;
  }

  function closedEvent(requestId: string, reason: "resolved" | "withdrawn" | "expired"): WebServerEvent {
    return {
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "interaction-closed",
        chatKey: "bot:c1:t1",
        sessionAlias: "brt_hidden",
        requestId,
        reason,
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
    mockRpc.mockResolvedValue({ responded: true, response: { requestId: "req-1", kind: "elicitation", action: "accept" } });
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "staging");
    store.setInteractionAnswer("note", "go");
    await store.submitInteraction("accept");
    expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.interaction.request", {
      requestId: "req-1",
      kind: "elicitation",
      action: "accept",
      content: { env: "staging", note: "go" },
    });
    expect(store.pendingInteraction!.outcome).toBe("accepted");
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
    mockRpc.mockResolvedValue({ responded: true, response: { requestId: "req-1", kind: "elicitation", action: "decline" } });
    store.applyEvent(openedEvent(formRequest()));
    store.setInteractionAnswer("env", "prod");
    await store.declineInteraction();
    expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.interaction.request", {
      requestId: "req-1",
      kind: "elicitation",
      action: "decline",
    });
    expect(store.pendingInteraction!.outcome).toBe("declined");
  });

  it("cancel is reported as its own outcome", async () => {
    const store = useDirectBotsStore();
    mockRpc.mockResolvedValue({ responded: true, response: { requestId: "req-1", kind: "elicitation", action: "cancel" } });
    store.applyEvent(openedEvent(formRequest()));
    await store.cancelInteraction();
    const payload = mockRpc.mock.calls[0]![2] as { action: string };
    expect(payload.action).toBe("cancel");
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

  it("a second opened form supersedes the first rather than stacking", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.applyEvent(openedEvent(formRequest({ requestId: "req-2" })));
    expect(store.pendingInteraction!.request.requestId).toBe("req-2");
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
});
