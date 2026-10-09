<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Archive, MessageSquare, Pencil, Plus, Users, X } from "lucide-vue-next";
import type { BotSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore, type GroupSendOutcome } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import GroupTranscript from "./GroupTranscript.vue";
import GroupComposer from "./GroupComposer.vue";
import GroupTopicDialog from "./GroupTopicDialog.vue";
import GroupDialog from "./GroupDialog.vue";
import ConversationWorktreePanel from "./ConversationWorktreePanel.vue";

const groupsStore = useGroupsStore();
const directBotsStore = useDirectBotsStore();
const instancesStore = useInstancesStore();
const { t, locale } = useI18n();

const newTopicDialogOpen = ref(false);
const groupDialogOpen = ref(false);
const needsFirstTopic = computed(() =>
  !!groupsStore.activeConversationId
  && groupsStore.topicReady
  && !groupsStore.activeTopicId
  && groupsStore.currentTopics.length === 0,
);

const group = computed(() => groupsStore.currentGroup);
const bots = computed<BotSummaryDto[]>(() => {
  const instId = groupsStore.instanceId;
  if (!instId) return [];
  return directBotsStore.botsByInstance[instId] ?? [];
});
const memberBots = computed<BotSummaryDto[]>(() => {
  const ids = new Set(group.value?.botIds ?? []);
  return bots.value.filter((b) => ids.has(b.id));
});

type MemberStatus =
  | { kind: "none-enabled" }
  | { kind: "some-disabled"; names: string; lead?: string; fallback?: string };
// An unconfirmed catalog would read as "every member disabled", so the
// status waits for it. The fallback comes from the same resolver the
// composer uses to pick the default target.
const memberStatus = computed<MemberStatus | null>(() => {
  const current = group.value;
  if (!current || !groupsStore.botCatalogKnown) return null;
  const disabled = memberBots.value.filter((b) => !b.enabled);
  if (disabled.length === 0) return null;
  const target = groupsStore.eligibleTargetFor(current, bots.value);
  if (target.mode !== "members") return { kind: "none-enabled" };
  return {
    kind: "some-disabled",
    names: new Intl.ListFormat(locale.value, { type: "conjunction" }).format(disabled.map((b) => b.name)),
    lead: disabled.find((b) => b.id === current.leadBotId)?.name,
    fallback: memberBots.value.find((b) => b.id === target.botIds[0])?.name,
  };
});

/** Resolves the send against the store so the composer can decide whether to drop
 *  the draft. A definitive refusal returns "rejected" and the text stays put. */
/** Resolves once the current send attempt finishes, so the composer can keep the
 *  draft when the refusal was definitive. */
function sendPromptOutcome(): Promise<GroupSendOutcome> {
  return groupsStore.sendPromptOutcomePromise;
}

function handleSend(text: string): void {
  void groupsStore.sendPrompt(text);
}

function handleCancel(): void {
  void groupsStore.cancelCurrentRun();
}

// An archived Topic stays browsable (its transcript is durable history), but it
// cannot accept new Runs — sending there is a guaranteed `topic_not_active`.
const isActiveTopic = computed(() => groupsStore.currentTopic?.status === "active");
const worktreeRunId = computed(() => {
  if (groupsStore.activeRun?.topicId === groupsStore.activeTopicId) return groupsStore.activeRun.id;
  // After reconnect there may be no active owner: integration belongs to the
  // latest durable result, even when that Run is already terminal.
  return [...groupsStore.messages].reverse().find(m => m.topicId === groupsStore.activeTopicId && m.runId)?.runId;
});
</script>

<template>
  <div class="flex h-full flex-col bg-bg text-fg">
    <header class="flex shrink-0 items-center justify-between border-b border-border bg-surface px-4 py-2.5">
      <div class="flex min-w-0 items-center gap-3">
        <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
          <Users :size="18" />
        </div>
        <div class="flex min-w-0 flex-col">
          <h2 class="truncate text-sm font-semibold">{{ group?.title ?? $t("group.nav.title") }}</h2>
          <div class="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <span>{{ $t("group.header.members", { count: group?.botIds.length ?? 0 }) }}</span>
            <span v-if="groupsStore.currentTopic">· {{ groupsStore.currentTopic.title }}</span>
            <span v-if="group?.lifecycle === 'deleting'"
                  data-test="group-pane-deleting-badge"
                  class="rounded bg-warn/15 px-1.5 py-px text-[10px] font-medium text-warn">
              {{ $t("group.list.deleting") }}
            </span>
          </div>
        </div>
      </div>
      <button
        v-if="group && groupsStore.instanceId"
        type="button"
        data-test="group-edit-button"
        :title="$t('group.manage.editTitle')"
        :aria-label="$t('group.manage.editTitle')"
        class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-raised hover:text-fg"
        @click="groupDialogOpen = true"
      >
        <Pencil :size="15" />
      </button>
    </header>

    <div class="flex items-center justify-between border-b border-border bg-surface/50 px-4 py-1.5 text-xs">
      <div class="thin-scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5">
        <span class="mr-1 flex shrink-0 items-center gap-1 text-[11px] font-medium text-fg-muted">
          <MessageSquare :size="12" />
          <span>{{ $t("bot.topic.label") }}:</span>
        </span>
        <button
          v-for="topic in groupsStore.currentTopics"
          :key="topic.id"
          type="button"
          data-test="group-topic-pill"
          :data-topic-status="topic.status"
          class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors"
          :class="groupsStore.activeTopicId === topic.id
            ? 'bg-accent/15 font-semibold text-accent'
            : 'text-fg-muted hover:bg-raised hover:text-fg'"
          @click="groupsStore.switchTopic(topic.id)"
        >
          <span class="max-w-[140px] truncate">{{ topic.title || $t("bot.topic.default") }}</span>
          <Archive v-if="topic.status !== 'active'" :size="10" class="shrink-0 opacity-70" />
        </button>
      </div>
      <button
        type="button"
        data-test="group-new-topic-button"
        class="ml-2 flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
        @click="newTopicDialogOpen = true"
      >
        <Plus :size="13" />
        <span>{{ $t("bot.topic.new") }}</span>
      </button>
    </div>

    <div v-if="groupsStore.generalErrorCode || groupsStore.generalError" class="flex items-center justify-between border-b border-danger/20 bg-danger/10 px-4 py-2 text-xs text-danger">
      <span>{{ groupsStore.generalErrorCode ? $t(`bot.errors.${groupsStore.generalErrorCode}`) : groupsStore.generalError }}</span>
      <button type="button" @click="groupsStore.generalError = null; groupsStore.generalErrorCode = null">
        <X :size="14" />
      </button>
    </div>

    <div v-if="memberStatus" data-test="group-member-status"
         class="space-y-0.5 border-b border-warn/20 bg-warn/10 px-4 py-1.5 text-xs text-fg">
      <p v-if="memberStatus.kind === 'none-enabled'">{{ $t("group.members.noneEnabled") }}</p>
      <template v-else>
        <p data-test="group-disabled-members">{{ $t("group.members.disabled", { names: memberStatus.names }) }}</p>
        <p v-if="memberStatus.lead && memberStatus.fallback" data-test="group-lead-disabled">
          {{ $t("group.members.leadDisabled", { lead: memberStatus.lead, fallback: memberStatus.fallback }) }}
        </p>
      </template>
    </div>

    <div v-if="needsFirstTopic"
         data-test="group-first-topic"
         class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <MessageSquare :size="22" class="text-fg-muted" />
      <p class="text-sm font-semibold">{{ $t("group.firstTopic.title") }}</p>
      <p class="max-w-sm text-xs text-fg-muted">{{ $t("group.firstTopic.hint") }}</p>
      <button
        type="button"
        data-test="group-first-topic-button"
        class="mt-1 flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90"
        @click="newTopicDialogOpen = true"
      >
        <Plus :size="13" />
        <span>{{ $t("group.firstTopic.action") }}</span>
      </button>
    </div>
    <GroupTranscript v-else :bots="memberBots" />
    <ConversationWorktreePanel v-if="groupsStore.currentTopic?.executionTarget?.isolation === 'worktree-per-member' && groupsStore.instanceId && worktreeRunId"
      :instance-id="groupsStore.instanceId" :run-id="worktreeRunId" />

    <GroupComposer
      :bots="memberBots"
      :disabled="!groupsStore.activeTopicId || !groupsStore.topicReady || !isActiveTopic"
      :instance-id="groupsStore.instanceId"
      :send-outcome="sendPromptOutcome"
      @send="handleSend"
      @cancel="handleCancel"
    />
    <div v-if="groupsStore.historyError && groupsStore.activeTopicId"
         class="flex items-center justify-between border-t border-danger/20 bg-danger/10 px-4 py-2 text-xs text-danger">
      <span>{{ groupsStore.historyErrorDetail ?? groupsStore.historyError }}</span>
      <button type="button"
              class="rounded bg-danger/20 px-2 py-0.5 font-medium transition-colors hover:bg-danger/30"
              @click="groupsStore.instanceId && groupsStore.activeConversationId && groupsStore.loadHistory(groupsStore.instanceId, groupsStore.activeConversationId, groupsStore.activeTopicId)">
        {{ $t("bot.prompt.retry") }}
      </button>
    </div>

    <GroupTopicDialog
      v-if="newTopicDialogOpen"
      @close="newTopicDialogOpen = false"
    />
    <GroupDialog
      v-if="groupDialogOpen && group && groupsStore.instanceId"
      :instance-id="groupsStore.instanceId"
      :group="group"
      @close="groupDialogOpen = false"
    />
  </div>
</template>
