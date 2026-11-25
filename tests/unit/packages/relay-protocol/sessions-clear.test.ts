import { describe, expect, test } from "bun:test";

import { parseControlPayload } from "@ganglion/xacpx-relay-protocol";
import { MSG } from "@ganglion/xacpx-relay-protocol";

describe("control.sessions.clear payload", () => {
  test("accepts a chat-scoped request naming one session", () => {
    expect(parseControlPayload(MSG.sessionsClear, {
      chatKey: "web:local",
      alias: "demo",
    })).not.toBeNull();
  });

  test("rejects a request that could not name a session", () => {
    // Without an alias the reset would fall back to the chat's current session, which
    // is not what the dashboard is showing — the daemon must not guess.
    expect(parseControlPayload(MSG.sessionsClear, { chatKey: "web:local" })).toBeNull();
    expect(parseControlPayload(MSG.sessionsClear, { alias: "demo" })).toBeNull();
  });

  test("rejects a non-string alias", () => {
    for (const alias of [1, null, {}, ["demo"]]) {
      expect(parseControlPayload(MSG.sessionsClear, { chatKey: "web:local", alias })).toBeNull();
    }
  });
});
