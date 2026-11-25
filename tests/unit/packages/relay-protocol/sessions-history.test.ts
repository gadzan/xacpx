import { describe, expect, test } from "bun:test";

import { parseControlPayload } from "@ganglion/xacpx-relay-protocol";
import { MSG } from "@ganglion/xacpx-relay-protocol";

describe("control.sessions.history payload", () => {
  test("accepts a chat-scoped request with and without a limit", () => {
    expect(parseControlPayload(MSG.sessionsHistory, {
      chatKey: "web:local",
      sessionAlias: "demo",
    })).not.toBeNull();
    expect(parseControlPayload(MSG.sessionsHistory, {
      chatKey: "web:local",
      sessionAlias: "demo",
      limit: 50,
    })).not.toBeNull();
  });

  test("rejects a request that could not name a session", () => {
    expect(parseControlPayload(MSG.sessionsHistory, { sessionAlias: "demo" })).toBeNull();
    expect(parseControlPayload(MSG.sessionsHistory, { chatKey: "web:local" })).toBeNull();
  });

  test("rejects a limit that is not a positive integer", () => {
    for (const limit of [0, -1, 1.5, "50"]) {
      expect(parseControlPayload(MSG.sessionsHistory, {
        chatKey: "web:local",
        sessionAlias: "demo",
        limit,
      })).toBeNull();
    }
  });
});
