import { expect, test } from "bun:test";

import { MSG } from "@ganglion/xacpx-relay-protocol";

import { eventChatKey, isLocalScope } from "../../../../packages/channel-web/src/events";
import { viewerWebEvent } from "../../../../packages/channel-web/src/terminal";

test("a fresh terminal starts with the screen snapshot, not later bytes", () => {
  const start = viewerWebEvent({
    type: "rebase-start",
    attachmentId: "a1",
    terminalId: "t1",
    generation: "g1",
    epoch: 1,
    nextSequence: 0,
    cols: 80,
    rows: 24,
    alternate: false,
    totalBytes: 4,
    chunkCount: 1,
  });
  expect(start?.kind).toBe("terminal-rebase-start");
  expect(isLocalScope(eventChatKey(MSG.instanceEvent, { event: { chatKey: "relay:other" } }))).toBe(false);
  expect(isLocalScope(eventChatKey(MSG.instanceEvent, { event: { chatKey: "web:local" } }))).toBe(true);
  expect(isLocalScope(eventChatKey(MSG.instanceEvent, { event: { type: "sessions-changed" } }))).toBe(true);
  expect(viewerWebEvent({
    type: "bytes",
    attachmentId: "a1",
    terminalId: "t1",
    generation: "g1",
    epoch: 1,
    sequence: 1,
    dataBase64: "aGk=",
  })?.kind).toBe("terminal-bytes");
});
