import { expect, test } from "bun:test";

import { MSG, RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/messages";
import { parseControlPayload } from "../../../../packages/relay-protocol/src/payload-validators";
import { parseWebServerEvent } from "../../../../packages/relay-protocol/src/web-dtos";
import type { RelayEnvelope } from "../../../../packages/relay-protocol/src/envelope";

/**
 * The relay interaction transport.
 *
 * These pin the two things the rest of M3 stands on: that a frame the hub or web
 * hands over is the shape core produced, and that no path lets a client assert
 * an identity.
 */

const VALID_FORM = {
  requestId: "req-1",
  kind: "elicitation" as const,
  expiresAt: 1_800_000_000_000,
  elicitation: {
    mode: "form" as const,
    message: "Which environment?",
    fields: [
      {
        kind: "single-select" as const,
        key: "env",
        title: "Environment",
        required: true,
        options: [
          { value: "prod", label: "Production" },
          { value: "staging", label: "Staging" },
        ],
      },
      { kind: "text" as const, key: "note", title: "Note", required: false },
      { kind: "number" as const, key: "hours", title: "Hours", required: true, integer: true, minimum: 1, maximum: 8 },
      { kind: "boolean" as const, key: "confirm", title: "Confirm", required: true },
    ],
  },
};

/**
 * A control-event in the web envelope shape `parseWebServerEvent` expects:
 * `kind: "control-event"` wrapping the inner `event`.
 */
function controlEventEnvelope(inner: unknown): RelayEnvelope {
  return {
    v: 1,
    kind: "event",
    type: "web.event",
    payload: { kind: "control-event", instanceId: "i1", event: inner },
  } as unknown as RelayEnvelope;
}

test("a core-shaped form request validates", () => {
  expect(parseControlPayload(MSG.interactionRequest, VALID_FORM)).toEqual(VALID_FORM);
});

test("a form request with a conversation product identity validates", () => {
  const parsed = parseControlPayload(MSG.interactionRequest, {
    ...VALID_FORM,
    conversation: {
      conversationId: "c1",
      topicId: "t1",
      runId: "r1",
      memberTurnId: "mt1",
      promptRequestId: "pr1",
    },
  });
  expect(parsed).not.toBeNull();
});

test("a form request carrying a hidden brt_* alias is rejected", () => {
  // Product routing keys only; a hidden runtime alias must never cross the wire.
  const parsed = parseControlPayload(MSG.interactionRequest, {
    ...VALID_FORM,
    conversation: {
      conversationId: "brt_hidden_1",
      topicId: "t1",
      runId: "r1",
      memberTurnId: "mt1",
    },
  });
  expect(parsed).toBeNull();
});

test("an elicitation request without its elicitation block is rejected", () => {
  // A renderer must never be handed a request it has nothing to render.
  expect(parseControlPayload(MSG.interactionRequest, {
    requestId: "req-1",
    kind: "elicitation",
    expiresAt: 1_800_000_000_000,
  })).toBeNull();
});

test("an elicitation request carrying a permission block is rejected", () => {
  const parsed = parseControlPayload(MSG.interactionRequest, {
    ...VALID_FORM,
    permission: { availableOutcomes: ["allow_once"] },
  });
  expect(parsed).toBeNull();
});

test("a non-form mode is rejected", () => {
  const parsed = parseControlPayload(MSG.interactionRequest, {
    requestId: "req-1",
    kind: "elicitation",
    expiresAt: 1_800_000_000_000,
    elicitation: { mode: "url", message: "visit", fields: [] },
  });
  expect(parsed).toBeNull();
});

test("a request with zero fields is rejected", () => {
  // A zero-field form has nothing to ask; the honest response is unsupported, not
  // an empty card.
  const parsed = parseControlPayload(MSG.interactionRequest, {
    requestId: "req-1",
    kind: "elicitation",
    expiresAt: 1_800_000_000_000,
    elicitation: { mode: "form", message: "", fields: [] },
  });
  expect(parsed).toBeNull();
});

test("a non-select kind carrying options is rejected", () => {
  // Options on a text field would invent a choice the agent never offered.
  const parsed = parseControlPayload(MSG.interactionRequest, {
    requestId: "req-1",
    kind: "elicitation",
    expiresAt: 1_800_000_000_000,
    elicitation: {
      mode: "form",
      message: "",
      fields: [
        {
          kind: "text",
          key: "note",
          title: "Note",
          required: true,
          options: [{ value: "a", label: "A" }],
        },
      ],
    },
  });
  expect(parsed).toBeNull();
});

test("an over-long field title is rejected", () => {
  const parsed = parseControlPayload(MSG.interactionRequest, {
    requestId: "req-1",
    kind: "elicitation",
    expiresAt: 1_800_000_000_000,
    elicitation: {
      mode: "form",
      message: "",
      fields: [{ kind: "text", key: "note", title: "T".repeat(201), required: true }],
    },
  });
  expect(parsed).toBeNull();
});

test("a select with no options is rejected", () => {
  const parsed = parseControlPayload(MSG.interactionRequest, {
    requestId: "req-1",
    kind: "elicitation",
    expiresAt: 1_800_000_000_000,
    elicitation: {
      mode: "form",
      message: "",
      fields: [{ kind: "single-select", key: "env", title: "Env", required: true, options: [] }],
    },
  });
  expect(parsed).toBeNull();
});

test("a non-finite expiresAt is rejected", () => {
  // NaN/Infinity would make the window either always-expired or never-expired.
  for (const expiresAt of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, "1800000000000"]) {
    expect(parseControlPayload(MSG.interactionRequest, { ...VALID_FORM, expiresAt })).toBeNull();
  }
});

test("a requestId over 128 chars is rejected", () => {
  const parsed = parseControlPayload(MSG.interactionRequest, {
    ...VALID_FORM,
    requestId: "r".repeat(129),
  });
  expect(parsed).toBeNull();
});

test("an unknown kind is rejected", () => {
  const parsed = parseControlPayload(MSG.interactionRequest, { ...VALID_FORM, kind: "url" });
  expect(parsed).toBeNull();
});

test("the reserved permission kind validates so the transport is exercised", () => {
  // M3 accepts the shape; nothing renders it. Declaring it unsupported here
  // would make the transport untested until the follow-up arrives.
  const parsed = parseControlPayload(MSG.interactionRequest, {
    requestId: "req-1",
    kind: "permission",
    expiresAt: 1_800_000_000_000,
    permission: { title: "Run shell", kind: "execute", availableOutcomes: ["allow_once", "reject_once"] },
  });
  expect(parsed).not.toBeNull();
});

test("an accept decision with content validates", () => {
  const parsed = parseControlPayload(MSG.interactionRespond, {
    requestId: "req-1",
    kind: "elicitation",
    action: "accept",
    content: { env: "prod", hours: 4, confirm: true, tags: ["a", "b"] },
  });
  expect(parsed).not.toBeNull();
});

test("a null content accept validates (all-optional form)", () => {
  const parsed = parseControlPayload(MSG.interactionRespond, {
    requestId: "req-1",
    kind: "elicitation",
    action: "accept",
    content: null,
  });
  expect(parsed).not.toBeNull();
});

test("decline and cancel carry no content", () => {
  for (const action of ["decline", "cancel"]) {
    expect(parseControlPayload(MSG.interactionRespond, {
      requestId: "req-1",
      kind: "elicitation",
      action,
    })).not.toBeNull();
    // ...and reject one that smuggles content in.
    expect(parseControlPayload(MSG.interactionRespond, {
      requestId: "req-1",
      kind: "elicitation",
      action,
      content: { env: "prod" },
    })).toBeNull();
  }
});

test("a decision smugglering a responder identity is rejected", () => {
  // Identity is stamped by the hub. A frame that asserts its own is a protocol
  // violation, not a field to ignore.
  for (const field of ["responderId", "senderId", "userId"]) {
    expect(parseControlPayload(MSG.interactionRespond, {
      requestId: "req-1",
      kind: "elicitation",
      action: "decline",
      [field]: "ou_attacker",
    })).toBeNull();
  }
});

test("an unknown action is rejected", () => {
  expect(parseControlPayload(MSG.interactionRespond, {
    requestId: "req-1",
    kind: "elicitation",
    action: "submit",
  })).toBeNull();
});

test("an over-long answer value is rejected", () => {
  const parsed = parseControlPayload(MSG.interactionRespond, {
    requestId: "req-1",
    kind: "elicitation",
    action: "accept",
    content: { note: "x".repeat(8001) },
  });
  expect(parsed).toBeNull();
});

test("the wire message names are stable", () => {
  expect(MSG.interactionRequest).toBe("control.interaction.request");
  expect(MSG.interactionRespond).toBe("control.interaction.respond");
});

test("the elicitation capability is advertised; permission is not", () => {
  // A capability named without a renderer is a lie the agent pays for. The
  // permission kind is reserved on the wire, so it is deliberately absent here.
  expect(RELAY_CAPABILITIES.interactionElicitationFormV1).toBe("interaction.elicitation.form.v1");
  expect(Object.values(RELAY_CAPABILITIES)).not.toContain("interaction.permission.v1");
});

test("an opened interaction reaches web through the control-event envelope", () => {
  const parsed = parseWebServerEvent(controlEventEnvelope({
    type: "interaction-opened",
    chatKey: "bot:c1:t1",
    sessionAlias: "brt_hidden",
    interaction: VALID_FORM,
  }));
  expect(parsed).not.toBeNull();
});

test("an opened interaction whose form fails validation is dropped before web", () => {
  // The last guard before the renderer: an invalid form must not reach a browser.
  const parsed = parseWebServerEvent(controlEventEnvelope({
    type: "interaction-opened",
    chatKey: "bot:c1:t1",
    sessionAlias: "brt_hidden",
    interaction: { ...VALID_FORM, elicitation: { mode: "form", message: "x", fields: [] } },
  }));
  expect(parsed).toBeNull();
});

test("a closed interaction reaches web", () => {
  for (const reason of ["resolved", "withdrawn", "expired"]) {
    expect(parseWebServerEvent(controlEventEnvelope({
      type: "interaction-closed",
      chatKey: "bot:c1:t1",
      sessionAlias: "brt_hidden",
      requestId: "req-1",
      reason,
    }))).not.toBeNull();
  }
});

test("a closed interaction with an unknown reason is dropped", () => {
  expect(parseWebServerEvent(controlEventEnvelope({
    type: "interaction-closed",
    chatKey: "bot:c1:t1",
    sessionAlias: "brt_hidden",
    requestId: "req-1",
    reason: "exploded",
  }))).toBeNull();
});

test("the web event type whitelist contains both interaction types", () => {
  // The exhaustiveness guard in web-dtos.ts is what forces a new control-event
  // member to be handled; it cannot be expressed as a runtime assertion, so this
  // checks the observable half — that both new types survive the walk from
  // envelope to parsed event.
  const opened = parseWebServerEvent(controlEventEnvelope({
    type: "interaction-opened",
    chatKey: "k",
    sessionAlias: "s",
    interaction: VALID_FORM,
  }));
  expect(opened).not.toBeNull();
});
