import { describe, expect, it } from "vitest";
import {
  contextTierOf,
  isSelfEndpoint,
  rankAgentMentions,
  textRankOf,
  type AgentAutocompleteContext,
  type RankableMentionItem,
} from "../lib/agent-mention-ranking";

function item(over: Partial<RankableMentionItem> = {}): RankableMentionItem {
  return {
    handle: "agent:node-1:ep-1",
    displayName: "Bot",
    agent: "codex",
    ...over,
  };
}

const ctx = (over: Partial<AgentAutocompleteContext> = {}): AgentAutocompleteContext => ({
  currentInstanceId: "inst-1",
  currentWorkspace: "xacpx",
  currentSessionAlias: "me",
  ...over,
});

describe("contextTierOf (spec §15)", () => {
  it("same workspace ranks Tier 0 even on another instance (Gate D note)", () => {
    expect(
      contextTierOf(item({ instanceId: "inst-2", workspace: "xacpx", endpointKind: "logical", channelId: "relay" }), ctx()),
    ).toBe(0);
  });

  it("same instance, different workspace is Tier 1", () => {
    expect(
      contextTierOf(item({ instanceId: "inst-1", workspace: "other", endpointKind: "logical", channelId: "relay" }), ctx()),
    ).toBe(1);
  });

  it("different instance, different workspace is Tier 2", () => {
    expect(
      contextTierOf(item({ instanceId: "inst-2", workspace: "other", endpointKind: "logical", channelId: "relay" }), ctx()),
    ).toBe(2);
  });

  it("non-Relay logical endpoint (channelId !== relay) is Tier 3 regardless of workspace", () => {
    expect(
      contextTierOf(item({ instanceId: "inst-1", workspace: "xacpx", endpointKind: "logical", channelId: "weixin" }), ctx()),
    ).toBe(3);
  });

  it("worker endpoint is Tier 3 regardless of workspace/instance", () => {
    expect(
      contextTierOf(item({ instanceId: "inst-1", workspace: "xacpx", endpointKind: "worker" }), ctx()),
    ).toBe(3);
  });

  it("legacy row (missing endpointKind AND channelId) is Tier 3", () => {
    expect(contextTierOf(item({ instanceId: "inst-1", workspace: "xacpx" }), ctx())).toBe(3);
  });

  it("logical row without channelId (relay implied by endpointKind) tiers normally", () => {
    expect(contextTierOf(item({ instanceId: "inst-1", workspace: "xacpx", endpointKind: "logical" }), ctx())).toBe(0);
  });

  it("no context degrades to kind facts: legacy/worker/non-Relay still Tier 3, relay rows fall through to Tier 2", () => {
    // With no currentInstanceId, instance affinity is unknowable, so relay
    // logical rows land on the neutral Tier 2 while metadata still pins Tier 3.
    expect(
      contextTierOf(item({ instanceId: "inst-1", workspace: "xacpx", endpointKind: "logical", channelId: "relay" }), {}),
    ).toBe(2);
    expect(
      contextTierOf(item({ instanceId: "inst-1", workspace: "xacpx", endpointKind: "worker" }), {}),
    ).toBe(3);
    expect(contextTierOf(item({ instanceId: "inst-1", workspace: "xacpx" }), {})).toBe(3);
  });
});

describe("isSelfEndpoint (canonical identity, never displayName)", () => {
  it("excludes only the endpoint matching instanceId AND sessionAlias", () => {
    const c = ctx();
    expect(isSelfEndpoint(item({ instanceId: "inst-1", sessionAlias: "me" }), c)).toBe(true);
    expect(isSelfEndpoint(item({ instanceId: "inst-2", sessionAlias: "me" }), c)).toBe(false);
    expect(isSelfEndpoint(item({ instanceId: "inst-1", sessionAlias: "peer" }), c)).toBe(false);
  });

  it("same display name never triggers exclusion", () => {
    expect(isSelfEndpoint(item({ instanceId: "inst-2", sessionAlias: "peer", displayName: "me" }), ctx())).toBe(false);
  });

  it("unknown sessionAlias disables exclusion (listing self beats hiding a peer)", () => {
    expect(isSelfEndpoint(item({ instanceId: "inst-1", sessionAlias: "me" }), { currentInstanceId: "inst-1" })).toBe(false);
    expect(isSelfEndpoint(item({ instanceId: "inst-1", sessionAlias: "me" }), { currentSessionAlias: "me" })).toBe(false);
  });
});

describe("textRankOf", () => {
  const it_ = (over: Partial<RankableMentionItem> = {}) => item({ displayName: "发布机器人", presentationSessionAlias: "omp-2", sessionAlias: "omp-2", workspace: "weacpx-github", agent: "codex", ...over });

  it("empty query ranks everything 0 (still listed)", () => {
    expect(textRankOf(it_(), "")).toBe(0);
  });

  it("exact visible displayName beats exact presentation alias", () => {
    expect(textRankOf(it_(), "发布机器人")).toBeLessThan(textRankOf(it_(), "omp-2"));
  });

  it("exact raw alias (distinct from presentation alias) is a distinct exact rank", () => {
    expect(textRankOf(it_({ sessionAlias: "omp-2-raw" }), "omp-2-raw")).toBeLessThanOrEqual(15);
    expect(textRankOf(it_({ sessionAlias: "omp-2-raw" }), "omp-2-raw")).toBeGreaterThan(0);
  });

  it("prefix beats contains", () => {
    const a = textRankOf(it_(), "发布");
    const b = textRankOf(it_(), "布机器");
    expect(a).toBeLessThan(b);
  });

  it("no match returns -1 (excluded)", () => {
    expect(textRankOf(it_(), "nomatch")).toBe(-1);
  });
});

describe("rankAgentMentions comparator (spec §16–17)", () => {
  const relay = (over: Partial<RankableMentionItem> = {}) =>
    item({ endpointKind: "logical", channelId: "relay", ...over });

  it("Gate D: empty query orders by context tier exactly", () => {
    const c = ctx();
    const ranked = rankAgentMentions(
      [
        relay({ handle: "h-nonrelay", displayName: "WeChat Bot", instanceId: "inst-2", workspace: "unrelated", endpointKind: "logical", channelId: "weixin" }),
        relay({ handle: "h-remote", displayName: "Remote", instanceId: "inst-2", workspace: "elsewhere" }),
        relay({ handle: "h-same-inst", displayName: "SameInst", instanceId: "inst-1", workspace: "other" }),
        relay({ handle: "h-same-ws", displayName: "SameWs", instanceId: "inst-9", workspace: "xacpx" }),
      ],
      "",
      c,
    );
    expect(ranked.map((r) => r.handle)).toEqual(["h-same-ws", "h-same-inst", "h-remote", "h-nonrelay"]);
  });

  it("Gate E: exact remote text match outranks same-workspace prefix match", () => {
    const c = ctx();
    const ranked = rankAgentMentions(
      [
        relay({ handle: "h-prefix", displayName: "文件浏览器功能助手", instanceId: "inst-1", workspace: "xacpx" }),
        relay({ handle: "h-exact", displayName: "文件浏览器功能", instanceId: "inst-9", workspace: "elsewhere" }),
      ],
      "文件浏览器功能",
      c,
    );
    expect(ranked.map((r) => r.handle)).toEqual(["h-exact", "h-prefix"]);
  });

  it("broad single-char query lets context tiers dominate text rank", () => {
    const c = ctx();
    const ranked = rankAgentMentions(
      [
        // displayName prefix match (best text rank) but Tier 2
        relay({ handle: "h-prefix-remote", displayName: "b-remote", instanceId: "inst-9", workspace: "elsewhere" }),
        // displayName contains match (worse text rank) but Tier 0
        relay({ handle: "h-contains-ws", displayName: "a-b-collaborator", instanceId: "inst-9", workspace: "xacpx" }),
      ],
      "b",
      c,
    );
    expect(ranked.map((r) => r.handle)).toEqual(["h-contains-ws", "h-prefix-remote"]);
  });

  it("prefix beats contains at the same tier", () => {
    const c = ctx();
    const ranked = rankAgentMentions(
      [
        relay({ handle: "h-contains", displayName: "xbotx", instanceId: "inst-1", workspace: "xacpx" }),
        relay({ handle: "h-prefix", displayName: "botx", instanceId: "inst-1", workspace: "xacpx" }),
      ],
      "bot",
      c,
    );
    expect(ranked.map((r) => r.handle)).toEqual(["h-prefix", "h-contains"]);
  });

  it("same instance wins within a tier", () => {
    const c = ctx();
    const ranked = rankAgentMentions(
      [
        relay({ handle: "h-remote", displayName: "A", instanceId: "inst-9", workspace: "other" }),
        relay({ handle: "h-local", displayName: "B", instanceId: "inst-1", workspace: "other" }),
      ],
      "",
      c,
    );
    expect(ranked.map((r) => r.handle)).toEqual(["h-local", "h-remote"]);
  });

  it("waiting activity outranks idle/working within a tier", () => {
    const c = ctx();
    const ranked = rankAgentMentions(
      [
        relay({ handle: "h-idle", displayName: "A", instanceId: "inst-1", workspace: "other", activity: { status: "idle" } }),
        relay({ handle: "h-waiting", displayName: "B", instanceId: "inst-1", workspace: "other", activity: { status: "waiting" } }),
        relay({ handle: "h-working", displayName: "C", instanceId: "inst-1", workspace: "other", activity: { status: "working" } }),
      ],
      "",
      c,
    );
    expect(ranked.map((r) => r.handle)).toEqual(["h-waiting", "h-idle", "h-working"]);
  });

  it("determinism: equal keys tie-break by name then handle", () => {
    const c = ctx();
    const ranked = rankAgentMentions(
      [
        relay({ handle: "agent:node-1:ep-9", displayName: "Beta", instanceId: "inst-1", workspace: "other" }),
        relay({ handle: "agent:node-1:ep-2", displayName: "Alpha", instanceId: "inst-1", workspace: "other" }),
        relay({ handle: "agent:node-1:ep-1", displayName: "Alpha", instanceId: "inst-1", workspace: "other" }),
      ],
      "",
      c,
    );
    expect(ranked.map((r) => r.handle)).toEqual([
      "agent:node-1:ep-1",
      "agent:node-1:ep-2",
      "agent:node-1:ep-9",
    ]);
  });

  it("self endpoint excluded; same-named peer stays", () => {
    const c = ctx();
    const ranked = rankAgentMentions(
      [
        relay({ handle: "h-self", displayName: "Me Bot", instanceId: "inst-1", sessionAlias: "me", workspace: "xacpx" }),
        relay({ handle: "h-peer", displayName: "Me Bot", instanceId: "inst-2", sessionAlias: "peer", workspace: "other" }),
      ],
      "me",
      c,
    );
    expect(ranked.map((r) => r.handle)).toEqual(["h-peer"]);
  });

  it("candidates matching nothing are excluded (filtering unchanged)", () => {
    const c = ctx();
    const ranked = rankAgentMentions(
      [
        relay({ handle: "h-match", displayName: "bot", instanceId: "inst-1", workspace: "xacpx" }),
        relay({ handle: "h-nomatch", displayName: "unrelated", instanceId: "inst-1", workspace: "xacpx" }),
      ],
      "bot",
      c,
    );
    expect(ranked.map((r) => r.handle)).toEqual(["h-match"]);
  });
});
