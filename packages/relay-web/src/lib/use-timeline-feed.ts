import { computed, ref, watch, type Ref } from "vue";
import {
  MSG,
  isErrorPayload,
  type ConversationTimelineDto,
  type ConversationTimelineEntryDto,
} from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { compareTimelineEntries } from "./room-view";

export interface TimelineFeedInput {
  instanceId: Ref<string | null | undefined>;
  conversationId: Ref<string | null | undefined>;
  topicId: Ref<string | null | undefined>;
  /** Capability gate: `control.conversation.timeline` exists on this instance. */
  enabled: Ref<boolean>;
  /** Any reactive fingerprint of the stores' live state (message count, newest
   *  seq, active Run identity). A change refetches the newest page; older pages
   *  already loaded stay. */
  reloadKey: Ref<string | number>;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

function readTimeline(payload: unknown): ConversationTimelineDto | null {
  if (isErrorPayload(payload)) return null;
  return payload as ConversationTimelineDto;
}

/**
 * Fetch the single Conversation read model (design §9.3) and keep it merged
 * across pages.
 *
 * The durable rows are the only source of truth: this feed never synthesizes
 * entries. Its one job is to keep the loaded window coherent when a page is
 * refetched — the newest page replaces the window it covers, older pages stay —
 * and to drop stale responses after a Topic switch.
 */
export function useConversationTimelineFeed(input: TimelineFeedInput) {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const entries = ref<ConversationTimelineEntryDto[]>([]);
  const activeRound = ref<ConversationTimelineDto["activeRound"]>(undefined);
  const loading = ref(false);
  const loadingOlder = ref(false);
  const error = ref<string | null>(null);
  const hasMoreBefore = ref(false);
  const hasMoreAfter = ref(false);
  /** True once the first page has landed for the current room. */
  const loaded = ref(false);

  const roomKey = computed(() => [
    input.instanceId.value ?? "",
    input.conversationId.value ?? "",
    input.topicId.value ?? "",
  ].join("\u0000"));

  let generation = 0;
  let refreshInFlight = false;
  let refreshQueued = false;

  function ready(): boolean {
    return input.enabled.value
      && !!input.instanceId.value
      && !!input.conversationId.value
      && !!input.topicId.value;
  }

  function mergeNewest(page: ConversationTimelineDto): void {
    const floor = page.oldestSeq ?? 0;
    const merged = new Map<string, ConversationTimelineEntryDto>();
    for (const entry of entries.value) {
      // Keep what the refetched window does not cover; the window itself is
      // replaced by the fresh rows so a changed row can never linger stale.
      if (entry.anchorSeq < floor) merged.set(entry.key, entry);
    }
    for (const entry of page.entries) merged.set(entry.key, entry);
    entries.value = [...merged.values()].sort(compareTimelineEntries);
    hasMoreBefore.value = page.hasMoreBefore;
    hasMoreAfter.value = page.hasMoreAfter;
    activeRound.value = page.activeRound;
  }

  function mergeOlder(page: ConversationTimelineDto): void {
    const merged = new Map<string, ConversationTimelineEntryDto>();
    for (const entry of entries.value) merged.set(entry.key, entry);
    for (const entry of page.entries) merged.set(entry.key, entry);
    entries.value = [...merged.values()].sort(compareTimelineEntries);
    hasMoreBefore.value = page.hasMoreBefore;
    // The active round belongs to the newest page; an older page must not
    // replace it.
  }

  async function fetchPage(cursor?: { beforeSeq: number }): Promise<ConversationTimelineDto | null> {
    const instanceId = input.instanceId.value;
    const conversationId = input.conversationId.value;
    const topicId = input.topicId.value;
    if (!instanceId || !conversationId || !topicId) return null;
    const payload = await api.rpc<ConversationTimelineDto>(instanceId, MSG.conversationTimeline, {
      conversationId,
      topicId,
      limit: pageSize,
      ...(cursor ? { beforeSeq: cursor.beforeSeq } : {}),
    });
    return readTimeline(payload);
  }

  async function refresh(): Promise<void> {
    if (!ready()) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    const requestGeneration = generation;
    const hadEntries = entries.value.length > 0;
    if (!hadEntries) loading.value = true;
    try {
      const page = await fetchPage();
      if (requestGeneration !== generation || !page) return;
      mergeNewest(page);
      error.value = null;
      loaded.value = true;
    } catch (err: unknown) {
      if (requestGeneration !== generation) return;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (requestGeneration === generation) loading.value = false;
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refresh();
      }
    }
  }

  async function loadOlder(): Promise<void> {
    if (!ready() || loadingOlder.value || !hasMoreBefore.value) return;
    const oldest = entries.value.reduce<number | undefined>(
      (min, entry) => (min === undefined ? entry.anchorSeq : Math.min(min, entry.anchorSeq)),
      undefined,
    );
    if (oldest === undefined) return;
    loadingOlder.value = true;
    const requestGeneration = generation;
    try {
      const page = await fetchPage({ beforeSeq: oldest });
      if (requestGeneration !== generation || !page) return;
      mergeOlder(page);
      error.value = null;
    } catch (err: unknown) {
      if (requestGeneration !== generation) return;
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (requestGeneration === generation) loadingOlder.value = false;
    }
  }

  function reset(): void {
    generation += 1;
    entries.value = [];
    activeRound.value = undefined;
    loading.value = false;
    loadingOlder.value = false;
    error.value = null;
    hasMoreBefore.value = false;
    hasMoreAfter.value = false;
    loaded.value = false;
    refreshQueued = false;
  }

  const timeline = computed<ConversationTimelineDto | null>(() => {
    if (!loaded.value) return null;
    return {
      conversationId: input.conversationId.value ?? "",
      topicId: input.topicId.value ?? "",
      entries: entries.value,
      ...(activeRound.value ? { activeRound: activeRound.value } : {}),
      ...(entries.value.length > 0 ? { oldestSeq: entries.value[0]!.anchorSeq } : {}),
      ...(entries.value.length > 0 ? { newestSeq: entries.value[entries.value.length - 1]!.anchorSeq } : {}),
      hasMoreBefore: hasMoreBefore.value,
      hasMoreAfter: hasMoreAfter.value,
    };
  });

  watch(roomKey, () => {
    reset();
    if (ready()) void refresh();
  }, { immediate: true });

  watch(() => input.enabled.value, (enabled) => {
    if (enabled && entries.value.length === 0) void refresh();
  });

  watch(() => input.reloadKey.value, () => {
    if (ready()) void refresh();
  });

  return {
    entries,
    timeline,
    activeRound,
    loading,
    loadingOlder,
    error,
    hasMoreBefore,
    hasMoreAfter,
    loaded,
    refresh,
    loadOlder,
    reset,
  };
}
