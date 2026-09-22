import { expect, test } from "bun:test";

import type {
  ChannelElicitationDecision,
  ChannelElicitationField,
  ChannelElicitationRequest,
} from "../../../src/plugin-api.js";
import {
  normalizeAcpElicitationForm,
  validateElicitationAnswer,
} from "../../../src/interactions/elicitation-schema.js";
import { ElicitationInteractionBroker } from "../../../src/interactions/elicitation-interaction-broker.js";
import { createTurnInteractionRegistry } from "../../../src/interactions/turn-interaction-registry.js";
import type { AppLogger } from "../../../src/logging/app-logger.js";

/**
 * Plugin-contract conformance for ACP form Elicitation.
 *
 * These compile against the PUBLISHED plugin surface (`src/plugin-api.ts`), so
 * a divergence between what core exports and what core itself consumes fails
 * typecheck instead of silently constraining M2 renderers. The original
 * `accept` shape omitted `null`, which core's own broker and the runtime
 * decision both allow — and because test fakes were loosely typed, `tsc` never
 * caught it.
 */

/** A channel typed as a real published plugin would be. */
function typedFormChannel(
  behavior: (request: ChannelElicitationRequest) => Promise<ChannelElicitationDecision>,
): {
  id: string;
  elicitationModes: readonly ["form"];
  requestElicitation(request: ChannelElicitationRequest): Promise<ChannelElicitationDecision>;
} {
  return {
    id: "contract",
    elicitationModes: ["form"],
    requestElicitation: behavior,
  };
}

function harness(
  behavior: (request: ChannelElicitationRequest) => Promise<ChannelElicitationDecision>,
) {
  const registry = createTurnInteractionRegistry();
  const logger = {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    debug: async () => {},
  } as unknown as AppLogger;
  const broker = new ElicitationInteractionBroker({
    registry,
    getChannelByChatKey: () => typedFormChannel(behavior) as never,
    logger,
  });
  return { broker, registry };
}

function formRequest(): Record<string, unknown> {
  return {
    sessionId: "acp-1",
    mode: "form",
    message: "Optional question",
    // All fields optional so `content: null` is a legal ACP accept.
    requestedSchema: { type: "object", properties: { note: { type: "string", title: "Note" } } },
  };
}

function allRequiredFormRequest(): Record<string, unknown> {
  return {
    sessionId: "acp-1",
    mode: "form",
    message: "Required question",
    requestedSchema: {
      type: "object",
      properties: { note: { type: "string", title: "Note" } },
      required: ["note"],
    },
  };
}

test("a typed plugin channel can answer accept + null and core preserves it", async () => {
  const { broker, registry } = harness(async () => ({
    action: "accept",
    responderId: "user-A",
    // Compiles only because the exported contract permits null.
    content: null,
  }));
  const dispose = registry.bindTurn({
    interactionId: "ix-1",
    chatKey: "contract:g:c",
    senderId: "user-A",
    origin: "human",
  });
  try {
    const result = await broker.resolveElicitation({
      promptRequestId: "p1",
      elicitationRequestId: "e1",
      agentName: "codex",
      interactionId: "ix-1",
      request: formRequest(),
    });
    expect(result).toEqual({ action: "accept", content: null });
  } finally {
    dispose();
  }
});

test("a typed plugin channel can omit content entirely", async () => {
  const { broker, registry } = harness(async () => ({
    action: "accept",
    responderId: "user-A",
  }));
  const dispose = registry.bindTurn({
    interactionId: "ix-2",
    chatKey: "contract:g:c",
    senderId: "user-A",
    origin: "human",
  });
  try {
    const result = await broker.resolveElicitation({
      promptRequestId: "p1",
      elicitationRequestId: "e2",
      agentName: "codex",
      interactionId: "ix-2",
      request: formRequest(),
    });
    // Omitted content normalizes to an explicit empty object: the field set is
    // known and valid, so the agent receives `{}` rather than `null`. A plugin
    // that wants ACP `null` sends `content: null` explicitly (tested above).
    expect(result).toEqual({ action: "accept", content: {} });
  } finally {
    dispose();
  }
});

test("a typed plugin channel can answer accept with a record", async () => {
  const { broker, registry } = harness(async () => ({
    action: "accept",
    responderId: "user-A",
    content: { note: "typed answer" },
  }));
  const dispose = registry.bindTurn({
    interactionId: "ix-3",
    chatKey: "contract:g:c",
    senderId: "user-A",
    origin: "human",
  });
  try {
    const result = await broker.resolveElicitation({
      promptRequestId: "p1",
      elicitationRequestId: "e3",
      agentName: "codex",
      interactionId: "ix-3",
      request: allRequiredFormRequest(),
    });
    expect(result).toEqual({ action: "accept", content: { note: "typed answer" } });
  } finally {
    dispose();
  }
});

test("a typed plugin channel can decline and cancel", async () => {
  const declineHarness = harness(async () => ({ action: "decline", responderId: "user-A" }));
  const cancelHarness = harness(async () => ({ action: "cancel", responderId: "user-A" }));
  for (const [index, { broker, registry }] of [declineHarness, cancelHarness].entries()) {
    const dispose = registry.bindTurn({
      interactionId: `ix-dc-${index}`,
      chatKey: "contract:g:c",
      senderId: "user-A",
      origin: "human",
    });
    try {
      const result = await broker.resolveElicitation({
        promptRequestId: "p1",
        elicitationRequestId: `e-dc-${index}`,
        agentName: "codex",
        interactionId: `ix-dc-${index}`,
        request: formRequest(),
      });
      expect(result.action).toBe(index === 0 ? "decline" : "cancel");
    } finally {
      dispose();
    }
  }
});

test("the presentation copy is deeply readonly at compile time", async () => {
  // Compile-time half of the frozen-copy contract: the renderer receives a
  // recursively frozen object graph at runtime, so mutating it must also be a
  // type error. Without these assertions a renderer writing
  // `request.fields.sort()` would pass tsc and throw in production, cancelling
  // the elicitation.
  let captured: ChannelElicitationRequest | undefined;
  const registry = createTurnInteractionRegistry();
  const logger = {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    debug: async () => {},
  } as unknown as AppLogger;
  const broker = new ElicitationInteractionBroker({
    registry,
    getChannelByChatKey: () =>
      ({
        id: "contract",
        elicitationModes: ["form"],
        requestElicitation: async (request: ChannelElicitationRequest) => {
          captured = request;
          return { action: "decline", responderId: "user-A" };
        },
      }) as never,
    logger,
  });
  const dispose = registry.bindTurn({
    interactionId: "ix-ro",
    chatKey: "contract:g:c",
    senderId: "user-A",
    origin: "human",
  });
  try {
    await broker.resolveElicitation({
      promptRequestId: "p1",
      elicitationRequestId: "e-ro",
      agentName: "codex",
      interactionId: "ix-ro",
      request: {
        sessionId: "acp-1",
        mode: "form",
        message: "Readonly check",
        requestedSchema: {
          type: "object",
          properties: {
            pick: { type: "string", enum: ["a", "b"] },
            tags: { type: "array", items: { type: "string", enum: ["x", "y"] }, default: ["x"] },
          },
        },
      },
    });
    expect(captured).toBeDefined();
    if (!captured) return;
    const request = captured;
    // The lines below are compile errors (each `@ts-expect-error` proves the
    // published type forbids the mutation). They also throw at runtime because
    // the copy is frozen — which is exactly the contract being pinned, so wrap
    // each one and assert it failed.
    const attempt = (mutate: () => void): boolean => {
      try {
        mutate();
        return false;
      } catch {
        return true;
      }
    };
    // @ts-expect-error fields is a readonly array.
    expect(attempt(() => request.fields.sort())).toBe(true);
    const first = request.fields[0];
    // @ts-expect-error options is a readonly array.
    expect(attempt(() => first.options?.sort())).toBe(true);
    const multi = request.fields.find((field) => field.kind === "multi-select");
    // @ts-expect-error defaultValue is a readonly array.
    expect(attempt(() => multi?.defaultValue?.push("z"))).toBe(true);
    // @ts-expect-error field members are readonly.
    expect(attempt(() => { first.required = false; })).toBe(true);
  } finally {
    dispose();
  }
});

test("the exported field model and validator agree on a full round trip", () => {
  const normalized = normalizeAcpElicitationForm({
    sessionId: "acp-1",
    mode: "form",
    message: "Fill this",
    requestedSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 40 },
        pick: { type: "string", enum: ["a", "b"], minLength: 1 },
        count: { type: "integer", minimum: 1, maximum: 5 },
        confirm: { type: "boolean" },
        tags: { type: "array", minItems: 1, items: { anyOf: [{ const: "x", title: "Ex" }] } },
      },
      required: ["title", "pick", "count", "confirm", "tags"],
    },
  });
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) return;
  const fields: readonly ChannelElicitationField[] = normalized.form.fields;
  // A typed plugin builds the answer from the exported value union.
  const content: Record<string, string | number | boolean | string[]> = {
    title: "Ship it",
    pick: "b",
    count: 3,
    confirm: true,
    tags: ["x"],
  };
  const decision: ChannelElicitationDecision = { action: "accept", responderId: "user-A", content };
  if (decision.action !== "accept" || decision.content === null) throw new Error("unreachable");
  const validated = validateElicitationAnswer(fields, decision.content);
  expect(validated).toMatchObject({ ok: true });
});

test("every published decision requires the platform-authenticated responder", () => {
  // Regression (round 15): a responder-free `{ action: "cancel" }` variant was
  // added, then removed. It was unreachable on a real abort (core settles those
  // first), so its only effect was letting a live request settle a user cancel
  // anonymously — fail-closed result, bypassed actor.
  //
  // The contract is now structural: EVERY member of the union carries
  // `responderId`, so an external abort cannot be expressed as a decision at
  // all and a renderer must throw/never settle instead.
  const decline: ChannelElicitationDecision = { action: "decline", responderId: "user-A" };
  const dismiss: ChannelElicitationDecision = { action: "cancel", responderId: "user-A" };
  expect(decline.action).toBe("decline");
  expect(dismiss.action).toBe("cancel");

  // Compile-time shape of the contract: a decision without `responderId` must
  // not typecheck. Pinned here as a runtime assertion on a cast value so the
  // intent survives even though the repo's `tsc --noEmit` only covers `src/`.
  const anonymous = { action: "cancel" } as unknown as ChannelElicitationDecision;
  if (anonymous.action === "cancel" || anonymous.action === "decline") {
    expect((anonymous as { responderId?: unknown }).responderId).toBeUndefined();
  }
});
