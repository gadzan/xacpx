import { beforeAll, expect, test } from "bun:test";

import {
  buildElicitationFieldCard,
  buildElicitationReviewCard,
  createElicitationToken,
  ELICITATION_CUSTOM_ID_PREFIX,
  elicitationCustomId,
  handleElicitationClick,
  parseElicitationCustomId,
} from "../../../../packages/channel-discord/src/elicitation-ui";
import { createAnswerMap, trySettle } from "../../../../packages/channel-discord/src/elicitation-state";
import type { PendingDiscordElicitation } from "../../../../packages/channel-discord/src/elicitation-state";
import type {
  ChannelElicitationDecision,
  ChannelElicitationRequest,
  ChannelElicitationValue,
} from "xacpx/plugin-api";
import { setChannelLocale } from "../../../../packages/channel-discord/src/i18n";

beforeAll(() => {
  setChannelLocale("en");
});

function request(overrides: Partial<ChannelElicitationRequest> = {}): ChannelElicitationRequest {
  return {
    requestId: "req-1",
    chatKey: "discord:default:g:c1",
    replyContextToken: "m1",
    requester: { senderId: "user-A", senderName: "Ada", isOwner: true },
    agent: { name: "codex" },
    message: "Deploy details",
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
      { kind: "text", key: "note", title: "Note", required: false, maxLength: 4000 },
    ],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<PendingDiscordElicitation> = {}): PendingDiscordElicitation {
  return {
    token: createElicitationToken(),
    requestId: "req-1",
    requesterId: "user-A",
    target: { channelId: "c1" },
    request: request(),
    // Null-prototyped, exactly like the channel builds it: a field key can be
    // `constructor`, and `skipped` is separate because an omitted answer is not
    // the same statement as an empty-string answer.
    values: createAnswerMap(),
    skipped: new Set<string>(),
    continuationMessageIds: [],
    visitedReview: false,
    reviewPage: 0,
    settled: false,
    // The published card revision and the spent counter. Both start at 1, like the
    // opening card, so a control naming revision 7 reads as a FUTURE card and is
    // never mistaken for a stale one.
    renderRevision: 1,
    claimedRevision: 1,
    resolve: () => {},
    reject: () => {},
    ...overrides,
  };
}

function interaction(token: string, userId: string, action: string, fieldIndex?: number, eph: string[] = []) {
  // Every control names the card it was drawn on, so the harness builds the same
  // shape the renderer does. An unversioned id is not a valid control for any
  // state-writing action and would be refused by the parser.
  return {
    customId: fieldIndex !== undefined
      ? elicitationCustomId(token, action as "field", fieldIndex, 7)
      : elicitationCustomId(token, action as "submit", undefined, 7),
    userId,
    acknowledge: async () => {},
    replyEphemeral: async (text: string) => {
      eph.push(text);
    },
  };
}

function harness(entry: PendingDiscordElicitation) {
  const pending = new Map<string, PendingDiscordElicitation>([[entry.token, entry]]);
  const decisions: ChannelElicitationDecision[] = [];
  const eph: string[] = [];
  const click = (action: string, userId = "user-A", fieldKey?: string) =>
    handleElicitationClick({
      interaction: interaction(entry.token, userId, action, fieldKey, eph),
      pending,
      onSettled: (_, decision) => {
        decisions.push(decision);
      },
    });
  return { pending, decisions, click, eph };
}

test("a reviewed form submits as accept carrying the collected answers", async () => {
  const entry = makeEntry();
  const { click, decisions } = harness(entry);
  click("start");
  click("field", "user-A", 0);
  // The renderer/collector stores the answer; here we stand in for it.
  entry.values.env = "prod";
  entry.values.note = "ship it";
  const outcome = await click("submit");
  expect(outcome.decided).toBe(true);
  expect(decisions).toEqual([
    { action: "accept", responderId: "user-A", content: { env: "prod", note: "ship it" } },
  ]);
});

test("a review submit with a missing required field does not commit", async () => {
  const entry = makeEntry();
  const { click, decisions, pending, eph } = harness(entry);
  await click("start");
  // The optional note was answered but the required select was not.
  entry.values.note = "ship it";
  const outcome = await click("submit");
  expect(outcome.decided).toBe(false);
  expect(decisions).toEqual([]);
  // The wizard is still live so the user can go back and answer.
  expect(pending.size).toBe(1);
  expect(entry.settled).toBe(false);
  expect(eph[eph.length - 1]).toContain("Required");
});

test("an all-optional form submits as a null content, not an empty object", async () => {
  const entry = makeEntry({
    request: request({
      fields: [
        { kind: "single-select", key: "any", title: "Anything", required: false, options: [{ value: "a", label: "A" }] },
      ],
    }),
  });
  const { click, decisions } = harness(entry);
  await click("start");
  // Nothing collected.
  const outcome = await click("submit");
  expect(outcome.decided).toBe(true);
  // `null` is ACP's "accept with no answers"; `{}` would be a different claim.
  expect(decisions[0]).toEqual({ action: "accept", responderId: "user-A", content: null });
});

test("a submit is impossible before the review card exists", async () => {
  // Structural: the submit control is only ever built on the review card, so a
  // user cannot reach accept without passing the review page.
  const entry = makeEntry();
  const { click } = harness(entry);
  await click("start");
  const ids: string[] = [];
  // The field card (post-start) and the review card are distinct renderings.
  const review = buildElicitationReviewCard(entry.request, entry.token, { env: "prod" });
  const row = review.components[0];
  for (const component of row?.components ?? []) ids.push(component.customId);
  expect(ids.some((id) => id.endsWith(":submit"))).toBe(true);
  // And the field cards built by the renderer never contain submit.
  const token = createElicitationToken();
  const { buildElicitationFieldCard } = await import("../../../../packages/channel-discord/src/elicitation-ui");
  const fieldCard = buildElicitationFieldCard(entry.request, token, entry.request.fields[0]!, 1, undefined);
  // All rows, not just the first: a mid-wizard field card needs 6 controls, so
  // they are split across two rows (a single action row holds 5).
  const fieldIds = fieldCard.components.flatMap((row) => row.components.map((c) => c.customId));
  expect(fieldIds.some((id) => id.endsWith(":submit"))).toBe(false);
  expect(fieldIds.some((id) => id.endsWith(":decline"))).toBe(true);
  expect(fieldIds.some((id) => id.endsWith(":cancel"))).toBe(true);
  // And no single row exceeds the platform's 5 buttons, which is what made a
  // 3+ text-field form's middle field undrawable before.
  for (const row of fieldCard.components) {
    expect(row.components.length).toBeLessThanOrEqual(5);
  }
});

test("a duplicate submit cannot decide twice", async () => {
  const entry = makeEntry();
  const { click, decisions } = harness(entry);
  entry.values.env = "prod";
  await click("submit");
  await click("submit");
  await click("submit");
  expect(decisions).toHaveLength(1);
});

test("an intruder may not submit the initiator's answers", async () => {
  const entry = makeEntry();
  const { click, decisions } = harness(entry);
  entry.values.env = "prod";
  const outcome = await click("submit", "user-INTRUDER");
  expect(outcome.decided).toBe(false);
  expect(decisions).toEqual([]);
  expect(entry.settled).toBe(false);
});

test("wizard progression routes to the requested field", async () => {
  const entry = makeEntry();
  const { click } = harness(entry);
  await click("start");
  expect(entry.currentField).toBe("env");
  await click("field", "user-A", 1);
  expect(entry.currentField).toBe("note");
  // An unknown field key does not change position.
  await click("field", "user-A", 99);
  expect(entry.currentField).toBe("note");
});

test("trySettle is the only way to settle and it wins exactly once", () => {
  const entry = makeEntry();
  expect(trySettle(entry)).toBe(true);
  expect(trySettle(entry)).toBe(false);
  expect(entry.settled).toBe(true);
});

test("every parsed control maps to a handled action", async () => {
  // A custom id that parses but has no handler branch would silently no-op,
  // so the action set is pinned against the parser's own. `skip` carries a field
  // position now: an action without one is dropped outright rather than falling
  // back to a cursor, which is what made two stale Skips skip two fields.
  //
  // Every control also carries its card revision, which is mandatory for all of
  // the navigation and state-writing actions — so building them without one must
  // NOT parse, and the loop below builds them the way the renderer does.
  for (const [action, fieldIndex] of [
    ["start", undefined],
    ["review", undefined],
    ["skip", 3],
    ["submit", undefined],
    ["decline", undefined],
    ["cancel", undefined],
    ["field", 0],
    ["edit", 1],
    ["page", 0],
  ] as const) {
    const parsed = parseElicitationCustomId(elicitationCustomId(createElicitationToken(), action, fieldIndex, 4));
    expect(parsed).not.toBeNull();
    expect(["start", "review", "skip", "submit", "decline", "cancel", "field", "edit", "page"]).toContain(parsed!.action);
    expect(parsed!.revision).toBe(4);
  }
  // A Skip with no position must NOT parse: refusing it is safer than guessing
  // the field from mutable state.
  expect(parseElicitationCustomId(elicitationCustomId(createElicitationToken(), "start"))).not.toBeNull();
  const token = createElicitationToken();
  expect(parseElicitationCustomId(`${ELICITATION_CUSTOM_ID_PREFIX}${token}:skip`)).toBeNull();
  // And neither must a Skip, field, edit, next or page without its revision.
  for (const [action, index] of [["skip", 0], ["field", 0], ["edit", 0], ["next", 0], ["page", 1]] as const) {
    expect(parseElicitationCustomId(`${ELICITATION_CUSTOM_ID_PREFIX}${token}:${action}:${index}`)).toBeNull();
  }
});
