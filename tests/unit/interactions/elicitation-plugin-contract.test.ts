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
        interactionId: `ix-dc-${index}`,
        request: formRequest(),
      });
      expect(result.action).toBe(index === 0 ? "decline" : "cancel");
    } finally {
      dispose();
    }
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
