<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AtSign, Bot, Check, ChevronDown, Users, X } from "lucide-vue-next";
import type { BotSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { completionKey, replaceRange, slashQuery } from "../lib/composer-completion";
import {
  filterMentionMembers,
  groupMentionQuery,
  mentionDisplayToken,
  reconcileMentions,
  type GroupMentionMember,
  type MentionBinding,
} from "../lib/group-mention";
import { useConversationCommandsStore } from "../stores/conversation-commands";
import { useGroupsStore, type GroupSendOutcome } from "../stores/groups";
import { useInstancesStore } from "../stores/instances";
import AgentIcon from "./AgentIcon.vue";
const props = defineProps<{
  bots: BotSummaryDto[];
  disabled?: boolean;
  instanceId?: string | null;
  /** Resolves when the parent's send attempt finishes. "rejected" means a
   *  definitive refusal with no durable accept, so the draft must be kept;
   *  "accepted" and "uncertain" are both safely recoverable (transcript / Retry).
   *  Optional: without a provider the draft is dropped, matching the previous
   *  behaviour for standalone use. */
  sendOutcome?: () => Promise<GroupSendOutcome>;
}>();

const emit = defineEmits<{
  send: [text: string];
  cancel: [];
}>();

const { t } = useI18n();
const groupsStore = useGroupsStore();
const instancesStore = useInstancesStore();
const commandStore = useConversationCommandsStore();
const promptText = ref("");
const menuOpen = ref(false);
const textareaEl = ref<HTMLTextAreaElement | null>(null);
const composing = ref(false);
const mentionBindings = ref<MentionBinding[]>([]);
const mentionOwned = ref(false);
const mentionActiveIdx = ref(0);
const cmdActiveIdx = ref(0);
const cmdDismissed = ref(false);
const mentionDismissed = ref(false);

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
    const onlyId = selectedIds.value[0]!;
    // The Bot name is presentation; when the catalog row is missing fall back to
    // the Lead label rather than pretending the selection is empty.
    return props.bots.find((b) => b.id === onlyId)?.name
      ?? (groupsStore.currentGroup?.leadBotId === onlyId ? t("group.target.lead") : onlyId);
  }
  return t("group.target.memberCount", { count: selectedIds.value.length });
});

/** Drop everything tied to a draft that is no longer editable: the text, the
 *  derived-mention suppression, the autogrow height and the picker menu.
 *  Called when a send reaches an Accepted or Uncertain outcome, and when the
 *  Topic changes underneath the composer. */
function clearSentDraft(): void {
  promptText.value = "";
  mentionBindings.value = [];
  mentionOwned.value = false;
  cmdDismissed.value = false;
  mentionDismissed.value = false;
  if (textareaEl.value) textareaEl.value.style.height = "auto";
  closeMenu();
}

// A Group/Topic switch drops the draft text, so the derived suppression must
// drop with it (otherwise the first mention in the next draft is ignored).
// `pre` is deliberate: `switchTopic()` sets `topicReady=false` at the same time,
// which disables the textarea, so the user cannot type into it before this runs.
watch(() => groupsStore.activeTopicId, () => {
  clearSentDraft();
});

function toggleMenu(): void {
  if (props.disabled) return;
  menuOpen.value = !menuOpen.value;
}

function closeMenu(): void {
  menuOpen.value = false;
}

function pickEveryone(): void {
  mentionOwned.value = false;
  groupsStore.mentionEveryone();
  closeMenu();
}

/** The Lead shortcut and the Group-open default share one resolver so a
 *  "Lead" pick can never re-select a Bot the member list itself disables. */
function pickLead(): void {
  const group = groupsStore.currentGroup;
  if (!group) return;
  // eligibleTargetFor applies the store's catalog-known state: an unconfirmed
  // catalog must widen to Everyone under no circumstances.
  const selection = groupsStore.eligibleTargetFor(group, props.bots);
  mentionOwned.value = false;
  groupsStore.setTarget(selection);
  closeMenu();
}

function toggleMember(botId: string): void {
  mentionOwned.value = false;
  groupsStore.toggleTargetMember(botId);
}

/** Agent driver for the picker's per-member icon. Same resolution as the
 *  transcript rows: instance agent catalog by agent name. Undefined (unknown
 *  agent, missing instance) renders the generic Bot glyph — identical to the
 *  transcript's `v-else` fallback. */
/** Agent driver for the picker's per-member icon. Same resolution as the
 *  transcript rows: instance agent catalog by agent name. Undefined (unknown
 *  agent, missing instance) renders the generic Bot glyph — identical to the
 *  transcript's `v-else` fallback. */
function driverFor(bot: BotSummaryDto): string | undefined {
  const instId = props.instanceId ?? groupsStore.instanceId;
  if (!instId) return undefined;
  return instancesStore.byId(instId)?.agents.find((a) => a.name === bot.agent)?.driver;
}

const mentionMembers = computed<GroupMentionMember[]>(() => {
  const leadId = groupsStore.currentGroup?.leadBotId;
  return props.bots.map((bot) => ({
    botId: bot.id,
    name: bot.name,
    ...(bot.role ? { role: bot.role } : {}),
    enabled: bot.enabled,
    lead: bot.id === leadId,
  }));
});

const singleMemberId = computed(() => {
  if (selection.value?.mode !== "members" || selectedIds.value.length !== 1) return null;
  return selectedIds.value[0] ?? null;
});

function commandsFor(botId: string) {
  const instanceId = props.instanceId ?? groupsStore.instanceId;
  const conversationId = groupsStore.activeConversationId;
  const topicId = groupsStore.activeTopicId;
  if (!instanceId || !conversationId || !topicId) return [];
  return commandStore.commandsFor({ instanceId, conversationId, topicId, botId });
}

const slash = computed(() => slashQuery(promptText.value));
const slashMatches = computed(() => {
  const query = slash.value;
  const botId = singleMemberId.value;
  if (!query || !botId || cmdDismissed.value) return [];
  return commandsFor(botId).filter((command) => command.name.toLowerCase().startsWith(query.query)).slice(0, 8);
});
const slashHint = computed(() => Boolean(slash.value) && !singleMemberId.value && !cmdDismissed.value);
const caret = ref(0);
const mentionQuery = computed(() => groupMentionQuery(promptText.value, caret.value));
const mentionMatches = computed(() => {
  const query = mentionQuery.value;
  if (!query || mentionDismissed.value) return [];
  return filterMentionMembers(mentionMembers.value, query.query).slice(0, 8);
});

watch(singleMemberId, () => {
  cmdDismissed.value = false;
  cmdActiveIdx.value = 0;
});

function mentionErrorCode(reason: "unknown" | "ambiguous" | "disabled" | "removed"): string {
  if (reason === "ambiguous") return "mentionAmbiguous";
  if (reason === "disabled") return "mentionDisabled";
  if (reason === "removed") return "mentionRemoved";
  return "mentionUnresolved";
}

function applyMention(text: string, endOfTextTerminates: boolean): boolean {
  const applied = reconcileMentions(text, mentionBindings.value, mentionMembers.value, endOfTextTerminates);
  if (applied.kind === "pending") {
    if (mentionOwned.value && !text.includes("@")) {
      mentionOwned.value = false;
      mentionBindings.value = [];
      groupsStore.setTarget({ mode: "members", botIds: [] });
    }
    return true;
  }
  mentionBindings.value = applied.bindings;
  mentionOwned.value = true;
  if (applied.kind === "unresolved") {
    groupsStore.setTarget({ mode: "members", botIds: [] });
    groupsStore.promptError = mentionErrorCode(applied.reason);
    groupsStore.promptErrorDetail = null;
    return false;
  }
  groupsStore.setTarget(applied.target);
  if (groupsStore.promptError?.startsWith("mention")) {
    groupsStore.promptError = null;
    groupsStore.promptErrorDetail = null;
  }
  return true;
}

function onInput(): void {
  cmdDismissed.value = false;
  mentionDismissed.value = false;
  cmdActiveIdx.value = 0;
  mentionActiveIdx.value = 0;
  caret.value = textareaEl.value?.selectionStart ?? promptText.value.length;
  const el = textareaEl.value;
  if (!el) return;
  applyMention(el.value, false);
  onInputResize();
}

function commitMentionAtBoundary(): boolean {
  const el = textareaEl.value;
  if (!el) return true;
  return applyMention(el.value, true);
}

function pickMention(member: GroupMentionMember): void {
  const query = mentionQuery.value;
  if (!query) return;
  const token = mentionDisplayToken(member.name);
  const replaced = replaceRange(promptText.value, query.range, `${token} `);
  mentionBindings.value = [
    ...mentionBindings.value.filter((binding) => binding.displayToken !== token || binding.botId === member.botId),
    { botId: member.botId, displayToken: token },
  ];
  promptText.value = replaced.text;
  mentionDismissed.value = true;
  applyMention(replaced.text, false);
  void nextTick(() => {
    textareaEl.value?.focus();
    textareaEl.value?.setSelectionRange(replaced.cursor, replaced.cursor);
  });
}

function pickSlash(name: string): void {
  const query = slash.value;
  const replaced = replaceRange(promptText.value, query?.range ?? { start: 0, end: promptText.value.length }, `/${name} `);
  promptText.value = replaced.text;
  cmdDismissed.value = true;
  void nextTick(() => {
    textareaEl.value?.focus();
    textareaEl.value?.setSelectionRange(replaced.cursor, replaced.cursor);
    onInputResize();
  });
}

function slashBroadcastBlocked(text: string): boolean {
  if (singleMemberId.value) return false;
  if (slashQuery(text)) return true;
  const token = text.trim().split(/\s+/, 1)[0] ?? "";
  if (!token.startsWith("/") || token.length < 2 || text.includes("\n")) return false;
  const name = token.slice(1).toLowerCase();
  return props.bots.some((bot) => commandsFor(bot.id).some((command) => command.name.toLowerCase() === name));
}

function onKeydown(e: KeyboardEvent): void {
  const collapsed = (textareaEl.value?.selectionStart ?? 0) === (textareaEl.value?.selectionEnd ?? 0);
  const mentionOpen = mentionMatches.value.length > 0;
  const slashOpen = !mentionOpen && slashMatches.value.length > 0;
  const action = completionKey({
    key: e.key,
    shiftKey: e.shiftKey,
    isComposing: e.isComposing,
    composing: composing.value,
    menu: mentionOpen ? "mention" : slashOpen || slashHint.value ? "slash" : "closed",
    itemCount: mentionOpen ? mentionMatches.value.length : slashOpen ? slashMatches.value.length : 0,
    activeIndex: mentionOpen ? mentionActiveIdx.value : cmdActiveIdx.value,
    holdKeys: slashHint.value && !mentionOpen,
    collapsedCaret: collapsed,
    busy: false,
    caretAtStart: false,
    historyArmed: false,
  });
  if (action.type === "ignore" || action.type === "passthrough") {
    if (e.key === "Escape") closeMenu();
    return;
  }
  if (action.type === "move") {
    if (mentionOpen) mentionActiveIdx.value = action.index;
    else cmdActiveIdx.value = action.index;
    e.preventDefault();
    return;
  }
  if (action.type === "commit") {
    if (mentionOpen) {
      const row = mentionMatches.value[action.index];
      if (row) pickMention(row);
    } else {
      const row = slashMatches.value[action.index];
      if (row) pickSlash(row.name);
    }
    e.preventDefault();
    return;
  }
  if (action.type === "dismiss" || action.type === "blocked") {
    mentionDismissed.value = true;
    cmdDismissed.value = true;
    if (e.key === "Escape") closeMenu();
    e.preventDefault();
    return;
  }
  if (action.type === "send") {
    e.preventDefault();
    void handleSend();
  }
}

/** Target-independent send guards. Checked first so the boundary mention can be
 *  committed before the target is re-evaluated — a mention is what makes an empty
 *  target valid for this very send. */
const baseCanSend = computed(() => !props.disabled
  && !groupsStore.promptInFlight
  && !groupsStore.isRunActive
  && groupsStore.topicReady
  // A fresh send is refused while a previous prompt's outcome is unknown: the
  // only way forward is replaying that prompt's frozen tuple.
  && !groupsStore.hasUncertainPrompt);

/** Final send guard: evaluated after any pending mention has been committed. */
const canSend = computed(() => baseCanSend.value
  && groupsStore.targetResolvable
  && promptText.value.trim().length > 0);

async function handleSend(): Promise<void> {
  if (!baseCanSend.value) {
    // Refuse before touching the draft: the store reports why (targetRequired /
    // targetEmpty), and clearing the textarea would throw the typed message away
    // with no recoverable request id and no Retry content.
    groupsStore.reportTargetProblem();
    return;
  }
  const text = promptText.value.trim();
  if (!text) return;
  if (slashBroadcastBlocked(text)) {
    groupsStore.promptError = "slashSelectMember";
    groupsStore.promptErrorDetail = null;
    return;
  }
  // The token under the caret is now final, so the structured target must
  // reflect it before the store resolves the send target.
  if (!commitMentionAtBoundary()) return;
  // Re-check after the boundary commit: the mention is what makes an empty
  // target valid for this very send, and entering text with no resolvable
  // target (e.g. deselected all members and typed nothing mentionable) must
  // surface the translated banner — not a send the local store refuses.
  if (!groupsStore.targetResolvable) {
    groupsStore.reportTargetProblem();
    return;
  }
  // The parent resolves the send against the store and reports the outcome, so
  // the draft decision uses the real result: an accepted prompt is in the
  // transcript, an uncertain one is replayable via Retry, but a definitive
  // refusal has neither and must leave the typed text in place.
  emit("send", text);
  if (props.sendOutcome) {
    // Textbook semantics: after a send the text no longer carries a mention, so
    // the derived state must reset or the next draft would inherit suppression.
    const outcome = await props.sendOutcome();
    // Only `accepted` and `uncertain` own this draft: their prompt is durably
    // represented (transcript, or replayable via Retry), so the text can go.
    //
    // `orphaned` must NOT touch the composer. The Topic watcher already dropped
    // this draft when the user switched Topics; whatever is in the textarea now
    // is a NEW draft typed against the new Topic, and clobbering it from a late
    // completion of another Topic's send loses real user input.
    //
    // `rejected` keeps the same draft: no durable accept exists, so the typed
    // text is the only remaining copy.
    if (outcome === "accepted" || outcome === "uncertain") {
      clearSentDraft();
    }
    return;
  }
  clearSentDraft();
}

function handleCancel(): void {
  emit("cancel");
}

/** Replay the frozen prompt tuple (requestId + text + target). Never re-derives
 *  from the current UI selection: the server keyed the durable accept on the
 *  original requestId, so a retry must resend exactly what may already be
 *  committed — switching members here would desync UI and execution. */
function handleRetry(): void {
  void groupsStore.retryUncertainPrompt();
}

function onInputResize(): void {
  if (!textareaEl.value) return;
  textareaEl.value.style.height = "auto";
  textareaEl.value.style.height = `${Math.min(textareaEl.value.scrollHeight, 200)}px`;
}
</script>

<template>
  <div class="border-t border-border bg-surface px-3 py-2.5 sm:px-4">
    <div v-if="groupsStore.promptError" data-test="group-prompt-error" class="mb-2 flex items-center justify-between gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger">
      <span class="truncate">{{ groupsStore.promptErrorDetail ?? $t(`bot.errors.${groupsStore.promptError}`) }}</span>
      <button
        v-if="groupsStore.uncertainPromptText"
        type="button"
        data-test="group-retry-prompt-button"
        class="rounded bg-danger/20 px-2 py-0.5 font-medium hover:bg-danger/30"
        @click="handleRetry"
      >
        {{ $t("bot.prompt.retry") }}
      </button>
    </div>

    <div class="mb-2 flex items-center gap-2">
      <div class="relative">
        <button
          type="button"
          data-test="group-target-button"
          :disabled="disabled || groupsStore.hasUncertainPrompt"
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
              :data-test="`group-target-member-${b.id}`"
              :disabled="!b.enabled"
              class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-raised disabled:opacity-50"
              @click="toggleMember(b.id)"
            >
              <AgentIcon v-if="driverFor(b)" :driver="driverFor(b)!" :title="b.agent" :size="14" :class="!b.enabled ? 'opacity-50' : ''" />
              <Bot v-else :size="14" :class="!b.enabled ? 'opacity-50' : ''" />
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
      <div
        v-if="slashHint"
        data-test="group-slash-hint"
        class="absolute bottom-full left-0 z-20 mb-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-xs text-fg-muted shadow-xl"
      >
        {{ $t("bot.errors.slashSelectMember") }}
      </div>
      <div
        v-else-if="slashMatches.length > 0"
        data-test="group-cmd-menu"
        class="absolute bottom-full left-0 z-20 mb-1.5 max-h-56 w-full overflow-y-auto rounded-xl border border-border bg-surface shadow-xl"
      >
        <button
          v-for="(command, index) in slashMatches"
          :key="command.name"
          type="button"
          data-test="group-cmd-item"
          class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs hover:bg-raised"
          :class="index === cmdActiveIdx ? 'bg-accent/10' : ''"
          @mousedown.prevent="pickSlash(command.name)"
        >
          <span class="font-medium text-fg">/{{ command.name }}</span>
          <span v-if="command.description" class="truncate text-fg-muted">{{ command.description }}</span>
        </button>
      </div>
      <div
        v-if="mentionMatches.length > 0"
        data-test="group-mention-menu"
        class="absolute bottom-full left-0 z-20 mb-1.5 max-h-56 w-full overflow-y-auto rounded-xl border border-border bg-surface shadow-xl"
      >
        <button
          v-for="(member, index) in mentionMatches"
          :key="member.botId"
          type="button"
          data-test="group-mention-item"
          :data-bot-id="member.botId"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-raised"
          :class="index === mentionActiveIdx ? 'bg-accent/10' : ''"
          @mousedown.prevent="pickMention(member)"
        >
          <span class="min-w-0 flex-1 truncate font-medium text-fg">@{{ member.name }}</span>
          <span v-if="member.lead" class="shrink-0 text-[10px] text-accent">{{ $t("group.target.lead") }}</span>
          <span v-if="member.role" class="shrink-0 truncate text-[10px] text-fg-muted">{{ member.role }}</span>
          <span class="shrink-0 text-[10px]" :class="member.enabled ? 'text-fg-muted' : 'text-warning'">
            {{ member.enabled ? $t("bot.status.enabled") : $t("bot.status.disabled") }}
          </span>
          <span class="shrink-0 font-mono text-[10px] text-fg-muted">{{ member.botId }}</span>
        </button>
      </div>
      <textarea
        ref="textareaEl"
        data-test="group-composer-textarea"
        v-model="promptText"
        :disabled="disabled || groupsStore.promptInFlight || groupsStore.isRunActive || !groupsStore.topicReady"
        :placeholder="$t('group.prompt.placeholder')"
        class="max-h-[200px] min-h-[38px] w-full resize-none bg-transparent px-2.5 py-2 text-sm text-fg outline-none placeholder:text-fg-muted disabled:cursor-not-allowed disabled:opacity-50"
        @keydown="onKeydown"
        @input="onInput"
        @compositionstart="composing = true"
        @compositionend="composing = false"
        @blur="commitMentionAtBoundary"
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
          :disabled="!canSend"
          class="grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          @click="handleSend"
        >
          <Check :size="16" :stroke-width="2.5" />
        </button>
      </div>
    </div>
  </div>
</template>
