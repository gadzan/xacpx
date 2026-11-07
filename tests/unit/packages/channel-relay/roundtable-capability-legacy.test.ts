import { expect, test } from "bun:test";

import { MSG, RELAY_CAPABILITIES, parseControlPayload } from "../../../../packages/relay-protocol/src/index";
import { supportsRoundtableV1 } from "../../../../packages/channel-relay/src/channel";

/**
 * An older connector package has no roundtable target and no `roundtableV1`
 * history field. The capability probe must see that validator, not only the
 * core probe, or the web would offer a target the connector rejects.
 */
const legacyParse: typeof parseControlPayload = (message, payload) => {
  const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  if (message === MSG.runsDetailsBatch && "roundtableV1" in record) return null;
  if (message === MSG.conversationPrompt
    && typeof record.target === "object" && record.target !== null
    && (record.target as { mode?: unknown }).mode === "roundtable") return null;
  return parseControlPayload(message, payload);
};

test("a true core probe is not enough when the resolved validator is old", () => {
  expect(supportsRoundtableV1({ supportsRoundtableV1: () => true }, legacyParse)).toBe(false);
  // The same probe passes once both wire halves are understood.
  expect(supportsRoundtableV1({ supportsRoundtableV1: () => true })).toBe(true);
});
