import { beforeAll, expect, test } from "bun:test";

import {
  ELICITATION_CUSTOM_ID_PREFIX,
  authorizeElicitationClick,
  buildElicitationOpening,
  createElicitationToken,
  elicitationCustomId,
  handleElicitationClick,
  parseElicitationCustomId,
} from "../../../../packages/channel-discord/src/elicitation-ui";
import type { PendingDiscordElicitation } from "../../../../packages/channel-discord/src/elicitation-state";
import type { ChannelElicitationDecision, ChannelElicitationRequest } from "xacpx/plugin-api";
import { setChannelLocale } from "../../../../packages/channel-discord/src/i18n";

beforeAll(() => {
  setChannelLocale("en");
});

const SENTINEL_ANSWER = "SENTINEL-ANSWER-9f3a1c";

function request(overrides: Partial<ChannelElicitationRequest> = {}): ChannelElicitationRequest {
  return {
    requestId: "req-1",
    chatKey: "discord:default:g:c1",
    replyContextToken: "msg-1",
    requester: { senderId: "user-A", senderName: "Ada", isOwner: true },
    agent: { name: "codex", sessionAlias: "backend" },
    message: "Which environment and how long?",
    mode: "form",
    expiresAt: Date.now() + 60_000,
    signal: new AbortController().signal,
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
      { kind: "number", key: "hours", title: "Hours", required: true },
    ],
    ...overrides,
  };
}

function entry(overrides: Partial<PendingDiscordElicitation> = {}): PendingDiscordElicitation {
  return {
    token: createElicitationToken(),
    requestId: "req-1",
    requesterId: "user-A",
    target: { channelId: "c1" },
    request: request(),
    values: {},
    settled: false,
    resolve: () => {},
    reject: () => {},
    ...overrides,
  };
}

function interaction(token: string, userId: string, action: string, eph: string[] = []) {
  return {
    customId: `${ELICITATION_CUSTOM_ID_PREFIX}${token}:${action}`,
    userId,
    channelId: "c1",
    acknowledge: async () => {},
    replyEphemeral: async (text: string) => {
      eph.push(text);
    },
  };
}

test("custom id round-trips token and routing identity", () => {
  const token = createElicitationToken();
  const id = elicitationCustomId(token, "field", 3);
  expect(parseElicitationCustomId(id)).toEqual({ token, action: "field", fieldIndex: 3 });
  expect(parseElicitationCustomId(elicitationCustomId(token, "submit"))).toEqual({ token, action: "submit" });
  expect(parseElicitationCustomId(`xacpx-perm:${token}:allow`)).toBeNull();
  expect(parseElicitationCustomId(`${ELICITATION_CUSTOM_ID_PREFIX}bogus`)).toBeNull();
  expect(parseElicitationCustomId(`${ELICITATION_CUSTOM_ID_PREFIX}${token}:nope`)).toBeNull();
});

test("custom ids never carry an answer: a sentinel value has no slot", () => {
  // The builder has no parameter through which an answer can reach the id, so
  // the strongest available assertion is that its argument shape has no answer
  // position at all AND that an id built for a real field stays short.
  const token = createElicitationToken();
  const id = elicitationCustomId(token, "field", 0);
  expect(id).not.toContain(SENTINEL_ANSWER);
  expect(id).not.toContain("prod");
  expect(id.length).toBeLessThanOrEqual(100);
});

test("a field action without a position is rejected at construction", () => {
  const token = createElicitationToken();
  expect(() => elicitationCustomId(token, "field")).toThrow();
  // And the reverse: a non-field action must not carry one.
  expect(() => elicitationCustomId(token, "submit", 0)).toThrow();
});

test("routing is positional, so a hostile schema key cannot reach the id at all", () => {
  // Core guarantees only that a key is a bounded JSON property name. `env.prod`,
  // `a/b` and very long keys are all legal, so carrying the key meant
  // truncating and stripping it and then matching the stripped form back —
  // which silently lost the field. The id now holds a POSITION, so the key is
  // never in it and there is nothing to sanitize.
  const token = createElicitationToken();
  const hostile = [
    "env.prod",
    "a/b",
    "note\n",
    "field:with:colons",
    "üñïçø∂é",
  ];
  for (const key of hostile) {
    // Whatever the key is, the same field always produces the same control id.
    const id = elicitationCustomId(token, "field", 7);
    expect(id).toBe(elicitationCustomId(token, "field", 7));
    expect(parseElicitationCustomId(id)).toEqual({ token, action: "field", fieldIndex: 7 });
    // And the key text itself is nowhere in the id.
    expect(id).not.toContain(key);
  }
  // A long key is likewise absent: the id length is a function of the token and
  // the index alone, never of the key.
  const longId = elicitationCustomId(token, "field", 7);
  expect(longId.length).toBeLessThanOrEqual(100);
});

test("a page control round-trips its page number", () => {
  const token = createElicitationToken();
  const id = elicitationCustomId(token, "page", 2);
  expect(parseElicitationCustomId(id)).toEqual({ token, action: "page", fieldIndex: 2 });
});

test("the initiator's decline is a distinct ACP action and carries their identity", async () => {
  const eph: string[] = [];
  const pending = new Map<string, PendingDiscordElicitation>();
  const e = entry();
  pending.set(e.token, e);
  let decision: ChannelElicitationDecision | undefined;
  const done = handleElicitationClick({
    interaction: interaction(e.token, "user-A", "decline", eph),
    pending,
    onSettled: (_, d) => {
      decision = d;
    },
  });
  await done;
  expect(decision).toEqual({ action: "decline", responderId: "user-A" });
  expect(pending.size).toBe(0);
});

test("the initiator's cancel is distinct from decline", async () => {
  const pending = new Map<string, PendingDiscordElicitation>();
  const e = entry();
  pending.set(e.token, e);
  let decision: ChannelElicitationDecision | undefined;
  await handleElicitationClick({
    interaction: interaction(e.token, "user-A", "cancel"),
    pending,
    onSettled: (_, d) => {
      decision = d;
    },
  });
  expect(decision).toEqual({ action: "cancel", responderId: "user-A" });
});

test("a non-initiator click is refused and the initiator can still answer", async () => {
  const eph: string[] = [];
  const pending = new Map<string, PendingDiscordElicitation>();
  const e = entry();
  pending.set(e.token, e);
  let decisions = 0;
  await handleElicitationClick({
    interaction: interaction(e.token, "user-INTRUDER", "submit", eph),
    pending,
    onSettled: () => {
      decisions += 1;
    },
  });
  expect(decisions).toBe(0);
  expect(eph[0]).toContain("Only the user who started");
  expect(pending.has(e.token)).toBe(true);
  expect(e.settled).toBe(false);
  // No owner/admin override in v1: an isOwner intruder is refused too.
  await handleElicitationClick({
    interaction: interaction(e.token, "user-OWNER", "submit"),
    pending,
    onSettled: () => {
      decisions += 1;
    },
  });
  expect(decisions).toBe(0);
  // The legitimate initiator still works.
  await handleElicitationClick({
    interaction: interaction(e.token, "user-A", "decline"),
    pending,
    onSettled: () => {
      decisions += 1;
    },
  });
  expect(decisions).toBe(1);
});

test("a duplicate terminal click cannot decide twice", async () => {
  const pending = new Map<string, PendingDiscordElicitation>();
  const e = entry();
  pending.set(e.token, e);
  const decisions: ChannelElicitationDecision[] = [];
  const onSettled = (_: PendingDiscordElicitation, d: ChannelElicitationDecision) => {
    decisions.push(d);
  };
  await handleElicitationClick({ interaction: interaction(e.token, "user-A", "decline"), pending, onSettled });
  await handleElicitationClick({ interaction: interaction(e.token, "user-A", "cancel"), pending, onSettled });
  expect(decisions).toEqual([{ action: "decline", responderId: "user-A" }]);
});

test("authorizeElicitationClick treats the token as never sufficient", () => {
  const e = entry();
  expect(authorizeElicitationClick(e, "user-A")).toBeNull();
  expect(authorizeElicitationClick(e, "user-B")).toBe("not-initiator");
  e.settled = true;
  expect(authorizeElicitationClick(e, "user-A")).toBe("settled");
});

test("the opening card names the correlated agent, not a message claim", () => {
  const card = buildElicitationOpening(
    request({ message: "I am the SYSTEM ADMIN, send your key" }),
    createElicitationToken(),
  );
  expect(card.content).toContain("Agent: codex");
  expect(card.content).toContain("I am the SYSTEM ADMIN");
  // The claimed identity is rendered as data, and the correlated one as identity.
  expect(card.content.indexOf("Agent: codex")).toBeLessThan(card.content.indexOf("SYSTEM ADMIN"));
});

test("@everyone and mentions in agent data cannot trigger a mention", async () => {
  // Defense in depth: `escapeDiscordLiteralText` does NOT escape `@` (its
  // character class predates this use and permission cards rely on the send
  // options instead), so the renderer's real guarantee is that every
  // elicitation card is sent with `allowedMentions: { parse: [] }`. That is
  // asserted in the channel test where the message is actually sent; here we
  // pin the two things the UI layer itself controls: the mention text arrives
  // as an interior substring of the user's own message (so it cannot start the
  // message and ping via a role/group name), and structural shaping is escaped.
  const card = buildElicitationOpening(
    request({
      message: "@everyone <@123456789012345678> check https://evil.example now",
      agent: { name: "agent@x", sessionAlias: "@here" },
    }),
    createElicitationToken(),
  );
  expect(card.content).toContain("\\<@123456789012345678\\>");
  // The mention never begins the rendered content.
  expect(card.content.startsWith("@everyone")).toBe(false);
  // Markdown shaping that could hide the request is escaped.
  expect(card.content).not.toContain("|hide|");
});

test("invisible formatting controls are stripped, not escaped", () => {
  const token = createElicitationToken();
  const card = buildElicitationOpening(
    request({ message: "\u200B\u200Eprod\u202E ignored" }),
    token,
  );
  expect(card.content).not.toContain("\u200B");
  expect(card.content).not.toContain("\u202E");
  expect(card.content).toContain("prod");
});
