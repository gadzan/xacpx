import { describe, expect, it } from "bun:test";

import { interactionResultForBrowser } from "../../../../packages/relay/src/http/app";

/**
 * The hub's responder-identity stamp.
 *
 * This is the load-bearing security line of the relay interaction transport: an
 * identity a client chose must never reach core, because core re-verifies it
 * against the exact turn initiator and a forged one would answer on someone
 * else's behalf.
 */
describe("interactionResultForBrowser", () => {
  const accept = {
    requestId: "req-1",
    kind: "elicitation" as const,
    action: "accept" as const,
    content: { env: "prod" },
  };

  it("stamps the hub's account identity onto a decision", () => {
    const shaped = interactionResultForBrowser(
      { responded: true, response: accept },
      "acct_42",
    ) as { responded: boolean; response: Record<string, unknown> };
    expect(shaped.responded).toBe(true);
    expect(shaped.response.responderId).toBe("acct_42");
    // And the decision itself survives untouched.
    expect(shaped.response.action).toBe("accept");
    expect(shaped.response.content).toEqual({ env: "prod" });
  });

  it("OVERWRITES a responderId the frame tried to supply", () => {
    // The mutation this guards against: reading the frame's identity instead of
    // stamping one. A tampered client would then answer as anyone.
    const shaped = interactionResultForBrowser(
      { responded: true, response: { ...accept, responderId: "acct_victim" } },
      "acct_42",
    ) as { response: Record<string, unknown> };
    expect(shaped.response.responderId).toBe("acct_42");
    expect(shaped.response.responderId).not.toBe("acct_victim");
  });

  it("stamps a decision that carried no identity at all", () => {
    const shaped = interactionResultForBrowser(
      { responded: true, response: { requestId: "req-1", kind: "elicitation", action: "decline" } },
      "acct_42",
    ) as { response: Record<string, unknown> };
    expect(shaped.response.responderId).toBe("acct_42");
  });

  it("keeps a non-response's reason so no decision is invented", () => {
    // The transport-closed cases must stay distinguishable from a user decision.
    for (const reason of ["timeout", "aborted", "shutdown", "unsupported", "channel-missing"]) {
      const shaped = interactionResultForBrowser({ responded: false, reason }, "acct_42") as {
        responded: boolean;
        reason: string;
        response?: unknown;
      };
      expect(shaped.responded).toBe(false);
      expect(shaped.reason).toBe(reason);
      expect(shaped.response).toBeUndefined();
    }
  });

  it("defaults a missing reason to aborted rather than dropping it", () => {
    const shaped = interactionResultForBrowser({ responded: false }, "acct_42") as { reason: string };
    expect(shaped.reason).toBe("aborted");
  });

  it("treats a non-object or identity-less response as closed", () => {
    for (const bad of [null, undefined, "string", 42, { responded: true }]) {
      const shaped = interactionResultForBrowser(bad, "acct_42") as {
        responded: boolean;
        reason: string;
      };
      expect(shaped.responded).toBe(false);
      expect(shaped.reason).toBe("aborted");
    }
  });
});
