/**
 * Context-aware @Agent autocomplete ranking (Agent Messaging v0.3 Capability B).
 *
 * Ranking/presentation ONLY: eligibility stays directory-owned. Every candidate
 * handed to `rankAgentMentions` must already be a canonical directory endpoint —
 * this module never re-derives reachability (no archived/deleted/offline rules).
 *
 * Ordering model (spec §15–17): textual relevance first for a clear query,
 * collaboration-context tiers dominating broad/empty queries, then deterministic
 * tie-breaks. No semantic/fuzzy-vector ranking anywhere.
 */

/** Composer context the ranking is relative to (spec §14). All fields optional —
 * ranking degrades to instance/channel/kind facts when absent. */
export interface AgentAutocompleteContext {
  currentInstanceId?: string;
  currentWorkspace?: string;
  currentSessionAlias?: string;
  currentEndpointHandle?: string;
}

/** Structural shape of a mention candidate. PromptInput's AgentMentionItem
 * satisfies this; the module stays component-free for unit testing. */
export interface RankableMentionItem {
  handle: string;
  displayName: string;
  presentationSessionAlias?: string;
  sessionAlias?: string;
  agent: string;
  workspace?: string;
  instanceId?: string;
  endpointKind?: "logical" | "worker";
  channelId?: string;
  activity?: {
    status: "idle" | "working" | "waiting";
    summary?: string;
  };
}

export type ContextTier = 0 | 1 | 2 | 3;

/**
 * Context priority tier (spec §15):
 * - 0: same workspace (workspace names may legitimately match across instances —
 *      same-workspace-other-instance still ranks first, Gate D)
 * - 1: same Relay instance, different workspace
 * - 2: different Relay instance
 * - 3: non-Relay logical (channelId present and !== "relay"), worker endpoint,
 *      or legacy row missing both endpointKind and channelId
 */
export function contextTierOf(
  item: Pick<RankableMentionItem, "instanceId" | "workspace" | "endpointKind" | "channelId">,
  ctx: AgentAutocompleteContext,
): ContextTier {
  if (item.endpointKind === "worker") return 3;
  if (!item.endpointKind && !item.channelId) return 3; // unknown / legacy context
  if (item.channelId && item.channelId !== "relay") return 3; // non-Relay logical
  // Relay logical endpoint: workspace affinity beats instance affinity.
  if (ctx.currentWorkspace && item.workspace === ctx.currentWorkspace) return 0;
  if (ctx.currentInstanceId && item.instanceId === ctx.currentInstanceId) return 1;
  return 2;
}

/**
 * Self exclusion by canonical identity only (spec §14): the endpoint that IS the
 * current session (same instance + same session alias). Never display-name
 * equality. Unknown context ⇒ no exclusion — listing self beats hiding a peer.
 * Worker endpoints publish no sessionAlias and can therefore never match self.
 */
export function isSelfEndpoint(
  item: Pick<RankableMentionItem, "instanceId" | "sessionAlias">,
  ctx: AgentAutocompleteContext,
): boolean {
  if (!ctx.currentInstanceId || !ctx.currentSessionAlias) return false;
  return (
    item.instanceId === ctx.currentInstanceId && item.sessionAlias === ctx.currentSessionAlias
  );
}

/**
 * Textual relevance (lower = better). Field granularity within each match class
 * keeps the long-standing behavior pinned by promptinput tests:
 * - exact:  displayName 11 < presentationAlias 12 < workspace 13 < agent 14 < rawAlias 15
 * - prefix: 21..25 (same field order)   - contains: 31..35 (same field order)
 * Empty query ⇒ 0 (everything listed); no match ⇒ -1 (excluded, as today).
 */
export function textRankOf(
  item: Pick<
    RankableMentionItem,
    "displayName" | "presentationSessionAlias" | "sessionAlias" | "workspace" | "agent"
  >,
  q: string,
): number {
  if (!q) return 0;
  const dn = item.displayName.toLowerCase();
  const psa = (item.presentationSessionAlias ?? "").toLowerCase();
  const rawSa = (item.sessionAlias ?? "").toLowerCase();
  const ws = (item.workspace ?? "").toLowerCase();
  const ag = item.agent.toLowerCase();

  if (dn === q) return 11;
  if (psa && psa === q) return 12;
  if (ws && ws === q) return 13;
  if (ag === q) return 14;
  if (rawSa && rawSa !== psa && rawSa === q) return 15;

  if (dn.startsWith(q)) return 21;
  if (psa && psa.startsWith(q)) return 22;
  if (ws && ws.startsWith(q)) return 23;
  if (ag.startsWith(q)) return 24;
  if (rawSa && rawSa !== psa && rawSa.startsWith(q)) return 25;

  if (dn.includes(q)) return 31;
  if (psa && psa.includes(q)) return 32;
  if (ws && ws.includes(q)) return 33;
  if (ag.includes(q)) return 34;
  if (rawSa && rawSa !== psa && rawSa.includes(q)) return 35;

  return -1;
}

/**
 * Activity tie-break. Only "waiting" (agent paused for input/attention — the
 * most actionable collaborator state) is promoted; idle and working are both
 * healthy steady states with no collaboration-relevant order between them, so
 * they defer to the stable name/handle tie-breaks. Deterministic by design.
 */
function activityRank(item: Pick<RankableMentionItem, "activity">): number {
  return item.activity?.status === "waiting" ? 0 : 1;
}

/**
 * Filter + deterministic sort of mention candidates for `query` under `ctx`.
 *
 * Comparator (spec §17), exactly:
 *   textRank ‖ contextTier ‖ sameInstance(true first) ‖ activity ‖ name ‖ handle
 *
 * Broad/empty queries ("@", or a single leading character — spec §16's "@b")
 * zero the text rank so context tiers dominate; two or more characters count
 * as a clear query where text match dominates scope.
 */
export function rankAgentMentions<T extends RankableMentionItem>(
  items: T[],
  query: string,
  ctx: AgentAutocompleteContext,
): T[] {
  const q = query.trim().toLowerCase();
  const broad = q.length <= 1;

  const scored = items
    .filter((item) => !isSelfEndpoint(item, ctx))
    .map((item) => {
      const rank = textRankOf(item, q);
      return {
        item,
        rank,
        sortRank: broad ? 0 : rank,
        tier: contextTierOf(item, ctx),
        sameInstance: Boolean(ctx.currentInstanceId) && item.instanceId === ctx.currentInstanceId,
      };
    })
    .filter((s) => s.rank !== -1);

  scored.sort(
    (a, b) =>
      a.sortRank - b.sortRank ||
      a.tier - b.tier ||
      Number(b.sameInstance) - Number(a.sameInstance) ||
      activityRank(a.item) - activityRank(b.item) ||
      a.item.displayName.localeCompare(b.item.displayName) ||
      a.item.handle.localeCompare(b.item.handle),
  );

  return scored.map((s) => s.item);
}
