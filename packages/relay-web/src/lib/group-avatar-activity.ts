import { ref, watch, type Ref } from "vue";
import { useGroupsStore } from "../stores/groups";

// ── group collage activity order ─────────────────────────────────────────────
// The avatar collage of a Group orders its members by who spoke last. That
// order must not reshuffle while the user watches the transcript, so it is
// SNAPSHOTTED instead of being derived from `groupsStore.messages` on every
// render: it recomputes when a group is entered and when its history loads,
// and stays frozen while live messages stream in.

/** The active group's members by most recent activity, newest first. */
export function useGroupAvatarActivity(): Ref<string[]> {
  const groupsStore = useGroupsStore();
  const activityBotIds = ref<string[]>([]);
  let snapshotGroupId: string | null = null;
  watch(
    () => [groupsStore.selectedGroupId, groupsStore.loadingHistory] as const,
    () => {
      const groupId = groupsStore.selectedGroupId;
      if (!groupId) {
        snapshotGroupId = null;
        activityBotIds.value = [];
        return;
      }
      // A load in flight is not the group's settled history yet.
      if (groupsStore.loadingHistory) {
        snapshotGroupId = null;
        return;
      }
      if (groupId === snapshotGroupId) return;
      snapshotGroupId = groupId;
      // `messages` is chronological, so the last speaker overall comes first
      // here. Members nobody has heard from keep the botIds order. The
      // conversation filter keeps a previous group's messages out of the
      // snapshot while the new group's history is still on its way.
      const conversationId = groupsStore.activeConversationId;
      const seen = new Set<string>();
      const order: string[] = [];
      for (let i = groupsStore.messages.length - 1; i >= 0; i--) {
        const message = groupsStore.messages[i];
        if (!message || message.conversationId !== conversationId) continue;
        const botId = message.senderBotId;
        if (!botId || seen.has(botId)) continue;
        seen.add(botId);
        order.push(botId);
      }
      activityBotIds.value = order;
    },
    { immediate: true },
  );
  return activityBotIds;
}
