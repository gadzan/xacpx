<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AtSign, Check, ChevronDown, Users, X } from "lucide-vue-next";
import type { BotSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore } from "../stores/groups";
import AgentIcon from "./AgentIcon.vue";

const props = defineProps<{
  bots: BotSummaryDto[];
  disabled?: boolean;
  instanceId?: string | null;
}>();

const emit = defineEmits<{
  send: [text: string];
  cancel: [];
}>();

const { t } = useI18n();
const groupsStore = useGroupsStore();

const promptText = ref("");
const menuOpen = ref(false);
const textareaEl = ref<HTMLTextAreaElement | null>(null);

const selection = computed(() => groupsStore.targetSelection);
const isEveryone = computed(() => selection.value?.mode === "everyone");
const selectedIds = computed<string[]>(() =>
  selection.value?.mode === "members" ? selection.value.botIds : [],
);
const eligibleBots = computed(() => props.bots.filter((b) => b.enabled));
const selectionLabel = computed(() => {
  if (isEveryone.value) return t("group.target.everyone");
  if (selectedIds.value.length === 0) return t("group.target.selectMembers");
  if (selectedIds.value.length === 1) {
    return props.bots.find((b) => b.id === selectedIds.value[0])?.name ?? t("group.target.selectMembers");
  }
  return t("group.target.memberCount", { count: selectedIds.value.length });
});

function toggleMenu(): void {
  if (props.disabled) return;
  menuOpen.value = !menuOpen.value;
}

function closeMenu(): void {
  menuOpen.value = false;
}

function pickEveryone(): void {
  groupsStore.mentionEveryone();
  closeMenu();
}

function pickLead(): void {
  const group = groupsStore.currentGroup;
  if (!group) return;
  const lead = group.leadBotId && group.botIds.includes(group.leadBotId)
    ? group.leadBotId
    : [...group.botIds].sort()[0];
  if (lead) groupsStore.setTarget({ mode: "members", botIds: [lead] });
  closeMenu();
}

function toggleMember(botId: string): void {
  groupsStore.toggleTargetMember(botId);
}

function driverFor(bot: BotSummaryDto): string | undefined {
  return undefined;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
  if (e.key === "Escape") closeMenu();
}

function handleInput(e: InputEvent): void {
  const el = textareaEl.value;
  if (!el) return;
  const value = el.value;
  const cursor = el.selectionStart ?? value.length;
  const before = value.slice(0, cursor);
  const atMatch = before.match(/@([\w-]*)$/);
  if (atMatch) {
    const query = atMatch[1]?.toLowerCase() ?? "";
    if (query === "everyone" || "everyone".startsWith(query)) {
      groupsStore.mentionEveryone();
    } else if (query.length > 0) {
      const match = props.bots.find((b) => b.name.toLowerCase() === query && b.enabled);
      if (match) groupsStore.mentionBot(match.id);
    }
  }
}

function handleSend(): void {
  if (props.disabled || groupsStore.promptInFlight || groupsStore.isRunActive || !groupsStore.topicReady) return;
  const text = promptText.value.trim();
  if (!text) return;
  emit("send", text);
  promptText.value = "";
  if (textareaEl.value) textareaEl.value.style.height = "auto";
  closeMenu();
}

function handleCancel(): void {
  emit("cancel");
}

function onInputResize(): void {
  if (!textareaEl.value) return;
  textareaEl.value.style.height = "auto";
  textareaEl.value.style.height = `${Math.min(textareaEl.value.scrollHeight, 200)}px`;
}
</script>

<template>
  <div class="border-t border-border bg-surface px-3 py-2.5 sm:px-4">
    <div v-if="groupsStore.promptError" class="mb-2 flex items-center justify-between gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger">
      <span class="truncate">{{ groupsStore.promptErrorDetail ?? groupsStore.promptError }}</span>
      <button
        v-if="groupsStore.lastPromptText"
        type="button"
        class="rounded bg-danger/20 px-2 py-0.5 font-medium hover:bg-danger/30"
        @click="emit('send', groupsStore.lastPromptText)"
      >
        {{ $t("bot.prompt.retry") }}
      </button>
    </div>

    <div class="mb-2 flex items-center gap-2">
      <div class="relative">
        <button
          type="button"
          data-test="group-target-button"
          :disabled="disabled"
          class="flex items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs font-medium text-fg transition-colors hover:border-accent/40 disabled:opacity-50"
          @click="toggleMenu"
        >
          <Users :size="13" class="text-accent" />
          <span class="max-w-[180px] truncate">{{ selectionLabel }}</span>
          <ChevronDown :size="12" class="text-fg-muted transition-transform" :class="menuOpen ? 'rotate-180' : ''" />
        </button>
        <div
          v-if="menuOpen"
          data-test="group-target-menu"
          class="absolute bottom-full left-0 z-20 mb-1.5 w-64 overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        >
          <div class="max-h-64 overflow-y-auto p-1.5">
            <button
              type="button"
              data-test="group-target-lead"
              class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-raised"
              @click="pickLead"
            >
              <AtSign :size="13" class="shrink-0 text-fg-muted" />
              <span class="flex-1 truncate font-medium">{{ $t("group.target.lead") }}</span>
            </button>
            <button
              type="button"
              data-test="group-target-everyone"
              class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-raised"
              @click="pickEveryone"
            >
              <Users :size="13" class="shrink-0 text-fg-muted" />
              <span class="flex-1 truncate font-medium">{{ $t("group.target.everyone") }}</span>
              <Check v-if="isEveryone" :size="13" class="shrink-0 text-accent" />
            </button>
            <div class="my-1 border-t border-border/60" />
            <div class="px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-fg-muted">
              {{ $t("group.target.selectMembers") }}
            </div>
            <button
              v-for="b in props.bots"
              :key="b.id"
              type="button"
              :data-test="`group-target-member-${b.id}`"
              :disabled="!b.enabled"
              class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-raised disabled:opacity-50"
              @click="toggleMember(b.id)"
            >
              <AgentIcon v-if="driverFor(b)" :driver="driverFor(b)!" :title="b.agent" :size="14" :class="!b.enabled ? 'opacity-50' : ''" />
              <span class="min-w-0 flex-1 truncate" :class="!b.enabled ? 'text-fg-muted' : 'text-fg'">{{ b.name }}</span>
              <span v-if="!b.enabled" class="shrink-0 text-[10px] text-fg-muted">{{ $t("bot.status.disabled") }}</span>
              <Check v-else-if="selectedIds.includes(b.id)" :size="13" class="shrink-0 text-accent" />
            </button>
            <p v-if="eligibleBots.length === 0" class="px-2.5 py-2 text-[11px] text-fg-muted">
              {{ $t("group.target.noEligible") }}
            </p>
          </div>
        </div>
      </div>
      <span class="hidden text-[11px] text-fg-muted sm:inline">{{ $t("group.target.hint") }}</span>
    </div>

    <div class="relative flex items-end gap-2 rounded-xl border border-border bg-bg p-1.5 transition-colors focus-within:border-accent">
      <textarea
        ref="textareaEl"
        v-model="promptText"
        :disabled="disabled || groupsStore.promptInFlight || groupsStore.isRunActive || !groupsStore.topicReady"
        :placeholder="$t('group.prompt.placeholder')"
        class="max-h-[200px] min-h-[38px] w-full resize-none bg-transparent px-2.5 py-2 text-sm text-fg outline-none placeholder:text-fg-muted disabled:cursor-not-allowed disabled:opacity-50"
        @keydown="onKeydown"
        @input="onInputResize"
        @input.capture="handleInput"
      />
      <div class="flex shrink-0 items-center gap-1 pb-1 pr-1">
        <button
          v-if="groupsStore.isRunActive"
          type="button"
          data-test="group-stop-run-button"
          :disabled="!!groupsStore.cancellingRunId"
          class="grid h-8 w-8 place-items-center rounded-lg bg-danger text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          @click="handleCancel"
        >
          <X :size="16" />
        </button>
        <button
          v-else
          type="button"
          data-test="group-send-prompt-button"
          :disabled="disabled || groupsStore.promptInFlight || !promptText.trim()"
          class="grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          @click="handleSend"
        >
          <Check :size="16" :stroke-width="2.5" />
        </button>
      </div>
    </div>
  </div>
</template>
