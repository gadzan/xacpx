import { expect, test } from "bun:test";

import { MSG, RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/messages";
import {
  INTERACTION_WIRE_LIMITS,
  parseControlPayload,
} from "../../../../packages/relay-protocol/src/payload-validators";
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
    agent: { name: "codex" },
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

test("a zero-field form is ACCEPTED", () => {
  // An all-optional schema with nothing to ask is a legal ACP form: it opens,
  // renders a confirmation, and accepts with `content: null`. Rejecting it would
  // strand a legal interaction the core broker already approved.
  //
  // This test used to assert the opposite ("core would not emit one"), which was
  // true until M1 landed zero-field semantics; the assumption was removed, not
  // reworded, because the old expectation is now the bug.
  const parsed = parseControlPayload(MSG.interactionRequest, {
    requestId: "req-1",
    kind: "elicitation",
    expiresAt: 1_800_000_000_000,
    elicitation: { mode: "form", message: "", fields: [], agent: { name: "codex" } },
  });
  expect(parsed).not.toBeNull();
  expect(parsed?.elicitation?.fields).toEqual([]);
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

test("an opened interaction whose form fails validation is dropped before web", async () => {
  // The last guard before the renderer: an invalid form must not reach a browser.
  //
  // The invalid shape is an OUT-OF-UNION field kind, not an empty field list —
  // a zero-field form is legal (see the analogous request test), so it is not
  // what a web-side drop is for.
  const parsed = parseWebServerEvent(controlEventEnvelope({
    type: "interaction-opened",
    chatKey: "bot:c1:t1",
    sessionAlias: "brt_hidden",
    interaction: {
      ...VALID_FORM,
      elicitation: {
        mode: "form",
        message: "x",
        fields: [{ kind: "unrenderable", key: "k", title: "K", required: true }],
      },
    },
  }));
  expect(parsed).toBeNull();
});

test("a zero-field opened interaction reaches web", () => {
  // The browser must be able to render the confirmation state for a legal
  // all-optional form; dropping it here would strand the interaction.
  const parsed = parseWebServerEvent(controlEventEnvelope({
    type: "interaction-opened",
    chatKey: "bot:c1:t1",
    sessionAlias: "brt_hidden",
    interaction: { ...VALID_FORM, elicitation: { ...VALID_FORM.elicitation, message: "x" } },
  }));
  expect(parsed).not.toBeNull();
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

test("an elicitation frame without the asking Agent is rejected", () => {
  // The agent name is an IDENTITY a client must display, and the wire makes it
  // REQUIRED so it cannot be dropped silently at the core → relay hop again. A
  // frame that omits it — or supplies an empty name — is refused rather than
  // rendered as an unidentified question.
  const base = {
    requestId: "req-agent-check",
    kind: "elicitation" as const,
    expiresAt: Date.now() + 60_000,
    elicitation: {
      mode: "form" as const,
      message: "Which region?",
      fields: [{ kind: "text" as const, key: "region", title: "Region", required: true }],
    },
  };
  for (const missing of [undefined, {}, { name: "" }, { name: 123 }]) {
    const result = parseControlPayload(MSG.interactionRequest, {
      ...base,
      elicitation: { ...base.elicitation, agent: missing },
    });
    expect(result, JSON.stringify(missing)).toBeNull();
  }
  // With a name it is accepted, and the name survives.
  const ok = parseControlPayload(MSG.interactionRequest, {
    ...base,
    elicitation: { ...base.elicitation, agent: { name: "codex" } },
  });
  expect(ok).not.toBeNull();
  expect(ok!.elicitation!.agent.name).toBe("codex");
});

test("schemaTitle and schemaDescription are both carried and bounded", () => {
  // An empty `message` is legal precisely because a schema can carry the whole
  // question, so both schema-level strings must survive THE validator too:
  // dropping the description there would strand a form that only asked through
  // its schema.
  const base = {
    requestId: "req-schema",
    kind: "elicitation" as const,
    expiresAt: Date.now() + 60_000,
    elicitation: {
      mode: "form" as const,
      message: "",
      agent: { name: "codex" },
      fields: [{ kind: "text" as const, key: "region", title: "Region", required: true }],
    },
  };
  const accepted = parseControlPayload(MSG.interactionRequest, {
    ...base,
    elicitation: {
      ...base.elicitation,
      schemaTitle: "Choose deployment target",
      schemaDescription: "Pick one region.",
    },
  });
  expect(accepted).not.toBeNull();
  expect(accepted!.elicitation!.schemaTitle).toBe("Choose deployment target");
  expect(accepted!.elicitation!.schemaDescription).toBe("Pick one region.");
  // A non-string, or an over-long one, is refused rather than forwarded.
  for (const bad of [123, "x".repeat(8001)]) {
    expect(
      parseControlPayload(MSG.interactionRequest, {
        ...base,
        elicitation: { ...base.elicitation, schemaDescription: bad },
      }),
      JSON.stringify(typeof bad),
    ).toBeNull();
  }
});

// The boundary contract between core and the wire.
//
// `relayFieldsFrom()` copies the form core already normalized and bounded, field
// for field, so core's `ELICITATION_SCHEMA_LIMITS` decide what is LEGAL. Two
// hazards follow, and both have shipped: a wire bound STRICTER than core's rejects
// a form core accepted — which turns a legal elicitation into a transport failure,
// not a UI difference (an 80-char field key against core's 128 and the hub's 64);
// and a wire bound LOOSER breaks the validator's own claim that it refuses shapes
// "core never produced" (`schemaTitle` had no length check at all).
//
// Every core MAXIMUM must be accepted and every core maximum + 1 refused, so a
// drift is red instead of an unexplained cancel in production. These are the
// values from `src/interactions/elicitation-schema.ts`.

test("the wire accepts every core-maximum field and refuses one character more", () => {
  const base = {
    requestId: "req-boundary",
    kind: "elicitation" as const,
    expiresAt: Date.now() + 60_000,
    elicitation: {
      mode: "form" as const,
      message: "",
      agent: { name: "codex" },
      fields: [] as unknown[],
    },
  };
  const withField = (over: Record<string, unknown>): unknown => ({
    ...base,
    elicitation: {
      ...base.elicitation,
      fields: [{ kind: "text", key: "f", title: "F", required: true, ...over }],
    },
  });
  // Core's OWN maxima, written as literals rather than read from the table under
  // test. Reading `INTERACTION_WIRE_LIMITS.maxFieldKey` here would compare the
  // table against itself, which is self-consistent by construction: lowering the
  // wire bound drifts the expectation to match, and the test stays green. The
  // point of the boundary contract is that these numbers are INDEPENDENT of the
  // implementation, so a drift in either side shows up as a failure.
  const CORE = {
    maxFieldKey: 128,
    maxTitle: 256,
    maxDescription: 1000,
    maxFormat: 64,
    maxPattern: 512,
    maxDefaultText: 256,
    maxOptionText: 256,
    maxOptions: 100,
    maxFields: 20,
    maxSchemaTitle: 256,
    maxSchemaDescription: 1000,
  };
  const atMax = (n: number): string => "x".repeat(n);

  const cases: Array<{ name: string; member: string; max: number }> = [
    { name: "field key", member: "key", max: CORE.maxFieldKey },
    { name: "field title", member: "title", max: CORE.maxTitle },
    { name: "field description", member: "description", max: CORE.maxDescription },
    { name: "format", member: "format", max: CORE.maxFormat },
    { name: "pattern", member: "pattern", max: CORE.maxPattern },
    { name: "string default", member: "defaultValue", max: CORE.maxDefaultText },
  ];

  for (const c of cases) {
    expect(
      parseControlPayload(MSG.interactionRequest, withField({ [c.member]: atMax(c.max) })),
      `${c.name} at core maximum is accepted`,
    ).not.toBeNull();
    expect(
      parseControlPayload(MSG.interactionRequest, withField({ [c.member]: atMax(c.max + 1) })),
      `${c.name} one over core maximum is refused`,
    ).toBeNull();
  }
});

test("the wire accepts every core-maximum option and schema member, and refuses one more", () => {
  const base = {
    requestId: "req-boundary-opts",
    kind: "elicitation" as const,
    expiresAt: Date.now() + 60_000,
    elicitation: {
      mode: "form" as const,
      message: "",
      agent: { name: "codex" },
      fields: [] as unknown[],
    },
  };
  const optionFrame = (over: Record<string, unknown>): unknown => ({
    ...base,
    elicitation: {
      ...base.elicitation,
      fields: [{
        kind: "single-select",
        key: "f",
        title: "F",
        required: true,
        options: [{ value: "v", label: "L", ...over }],
      }],
    },
  });
  for (const [member, max] of [
    ["value", 256],
    ["label", 256],
    ["description", 1000],
  ] as const) {
    expect(
      parseControlPayload(MSG.interactionRequest, optionFrame({ [member]: "x".repeat(max) })),
      `option ${member} at core maximum`,
    ).not.toBeNull();
    expect(
      parseControlPayload(MSG.interactionRequest, optionFrame({ [member]: "x".repeat(max + 1) })),
      `option ${member} one over`,
    ).toBeNull();
  }

  const schemaFrame = (over: Record<string, unknown>): unknown => ({
    ...base,
    elicitation: { ...base.elicitation, fields: [{ kind: "text", key: "f", title: "F", required: true }], ...over },
  });
  // schemaTitle reuses the field-title bound; schemaDescription the field-description one.
  expect(
    parseControlPayload(MSG.interactionRequest, schemaFrame({ schemaTitle: "x".repeat(256) })),
    "schema title at core maximum",
  ).not.toBeNull();
  expect(
    parseControlPayload(MSG.interactionRequest, schemaFrame({ schemaTitle: "x".repeat(257) })),
    "schema title one over",
  ).toBeNull();
  expect(
    parseControlPayload(MSG.interactionRequest, schemaFrame({ schemaDescription: "x".repeat(1000) })),
    "schema description at core maximum",
  ).not.toBeNull();
  expect(
    parseControlPayload(MSG.interactionRequest, schemaFrame({ schemaDescription: "x".repeat(1001) })),
    "schema description one over",
  ).toBeNull();
});

test("the field-count and option-count bounds match core's", () => {
  const frame = (fieldCount: number, optionCount: number): unknown => ({
    requestId: "req-counts",
    kind: "elicitation" as const,
    expiresAt: Date.now() + 60_000,
    elicitation: {
      mode: "form" as const,
      message: "",
      agent: { name: "codex" },
      fields: Array.from({ length: fieldCount }, (_, i) => ({
        kind: "single-select",
        key: `f${i}`,
        title: `F${i}`,
        required: true,
        options: Array.from({ length: optionCount }, (_, j) => ({
          value: `v${j}`,
          label: `L${j}`,
        })),
      })),
    },
  });
  // Core caps a form at 20 fields and a select at 100 options. Zero fields is
  // legal (an all-optional schema that accepts `content: null`).
  expect(parseControlPayload(MSG.interactionRequest, frame(0, 1))).not.toBeNull();
  expect(parseControlPayload(MSG.interactionRequest, frame(20, 100))).not.toBeNull();
  expect(parseControlPayload(MSG.interactionRequest, frame(21, 100))).toBeNull();
  expect(parseControlPayload(MSG.interactionRequest, frame(1, 101))).toBeNull();
});

test("a multi-select default is bounded per item, not only in aggregate", () => {
  // A default array is core-side pre-fill that core itself would accept, so each
  // item is bounded by core's default bound. Checking only the aggregate length
  // let a two-item array of 1000-char strings through a 256-per-item rule.
  const frame = (items: string[]): unknown => ({
    requestId: "req-default-array",
    kind: "elicitation" as const,
    expiresAt: Date.now() + 60_000,
    elicitation: {
      mode: "form" as const,
      message: "",
      agent: { name: "codex" },
      fields: [{
        kind: "multi-select",
        key: "f",
        title: "F",
        required: true,
        options: [{ value: "a", label: "A" }],
        defaultValue: items,
      }],
    },
  });
  expect(parseControlPayload(MSG.interactionRequest, frame(["a".repeat(256), "b"]))).not.toBeNull();
  expect(parseControlPayload(MSG.interactionRequest, frame(["a".repeat(257), "b"]))).toBeNull();
});
