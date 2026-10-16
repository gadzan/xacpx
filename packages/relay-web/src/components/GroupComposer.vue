<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AtSign, Bot, Check, ChevronDown, Users } from "lucide-vue-next";
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
import BotAvatar from "./BotAvatar.vue";
import ConversationComposer from "./ConversationComposer.vue";
import DropdownPanel from "./DropdownPanel.vue";
import { useDropdown } from "../lib/use-dropdown";
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
const targetDd = useDropdown();
const composer = ref<InstanceType<typeof ConversationComposer> | null>(null);
const composing = ref(false);
const collapsedCaret = ref(true);
const mentionBindings = ref<MentionBinding[]>([]);
const mentionOwned = ref(false);
const mentionActiveIdx = ref(0);
const cmdActiveIdx = ref(0);
const cmdDismissed = ref(false);
const mentionDismissed = ref(false);

const selection = computed(() => groupsStore.targetSelection);
const isEveryone = computed(() => selection.value?.mode === "everyone");
const isAutomatic = computed(() => selection.value?.mode === "automatic");
const availability = computed(() => {
  const id = props.instanceId ?? groupsStore.instanceId;
  if (!id) {
    return {
      status: "unsupported" as const,
      configPath: "conversations.router" as const,
      reason: { code: "not-advertised" as const, message: t("group.router.noInstance") },
    };
  }
  return instancesStore.routerAvailabilityFor(id);
});
const automaticReady = computed(() => availability.value.status === "ready");
/** The Jev panel state for the same instance. The automatic option is only
 *  offered when the daemon both reports the router ready AND has a Jev key
 *  configured; an older daemon (read-only panel) hides it entirely. */
const jevPanel = computed(() => {
  const id = props.instanceId ?? groupsStore.instanceId;
  return id ? instancesStore.jevPanelFor(id) : { phase: "read-only" as const, notice: "" };
});
const jevConfigured = computed(() =>
  jevPanel.value.phase === "editable" && jevPanel.value.settings.keyConfigured);
const automaticVisible = computed(() => automaticReady.value && jevConfigured.value);
const selectedIds = computed<string[]>(() =>
  selection.value?.mode === "members" ? selection.value.botIds : [],
);
const eligibleBots = computed(() => props.bots.filter((b) => b.enabled));
const selectionLabel = computed(() => {
  if (isAutomatic.value) return t("group.target.automatic");
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
  targetDd.toggle();
}

function closeMenu(): void {
  targetDd.closeMenu();
}

/** Keyboard activation order matches the rendered rows (disabled members excluded). */
const navRows = computed<Array<() => void>>(() => {
  const rows: Array<() => void> = [() => pickLead()];
  if (automaticVisible.value) rows.push(() => pickAutomatic());
  rows.push(() => pickEveryone());
  for (const b of props.bots) {
    if (b.enabled) rows.push(() => toggleMember(b.id));
  }
  return rows;
});
const navCount = computed(() => navRows.value.length);
function onNavSelect(index: number): void {
  navRows.value[index]?.();
}

function pickEveryone(): void {
  mentionOwned.value = false;
  groupsStore.mentionEveryone();
  closeMenu();
}

function pickAutomatic(): void {
  if (!automaticVisible.value) return;
  mentionOwned.value = false;
  groupsStore.setTarget({ mode: "automatic" });
  closeMenu();
}

watch(() => props.instanceId ?? groupsStore.instanceId, (id) => {
  if (id) {
    void instancesStore.loadRouterAvailability(id);
    void instancesStore.loadJevSettings(id);
  }
}, { immediate: true });

watch(availability, (state) => {
  if (state.status === "ready" || groupsStore.targetSelection?.mode !== "automatic") return;
  const group = groupsStore.currentGroup;
  groupsStore.setTarget(group ? groupsStore.eligibleTargetFor(group, props.bots) : { mode: "members", botIds: [] });
}, { immediate: true });

// Losing the Jev key (cleared in another tab, or an instance that stopped
// reporting it) drops an in-progress automatic selection exactly like losing
// router readiness does.
watch(automaticVisible, (visible) => {
  if (visible || groupsStore.targetSelection?.mode !== "automatic") return;
  const group = groupsStore.currentGroup;
  groupsStore.setTarget(group ? groupsStore.eligibleTargetFor(group, props.bots) : { mode: "members", botIds: [] });
});

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

function onInput(text: string): void {
  cmdDismissed.value = false;
  mentionDismissed.value = false;
  cmdActiveIdx.value = 0;
  mentionActiveIdx.value = 0;
  applyMention(text, false);
}

function commitMentionAtBoundary(): boolean {
  return applyMention(promptText.value, true);
}

function onCaret(selection: { start: number; end: number }): void {
  caret.value = selection.start;
  collapsedCaret.value = selection.start === selection.end;
}

function onCompositionEnd(): void {
  composing.value = false;
  onInput(promptText.value);
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
    composer.value?.focus();
    composer.value?.setSelectionRange(replaced.cursor, replaced.cursor);
  });
}

function pickSlash(name: string): void {
  const query = slash.value;
  const replaced = replaceRange(promptText.value, query?.range ?? { start: 0, end: promptText.value.length }, `/${name} `);
  promptText.value = replaced.text;
  cmdDismissed.value = true;
  void nextTick(() => {
    composer.value?.focus();
    composer.value?.setSelectionRange(replaced.cursor, replaced.cursor);
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
    collapsedCaret: collapsedCaret.value,
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
</script>

<template>
  <div class="shrink-0 bg-gradient-to-t from-bg to-transparent px-2 lg:px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-1.5">
    <div v-if="groupsStore.promptError" data-test="group-prompt-error" class="mb-2 flex items-center justify-between gap-2 rounded-lg bg-danger/10 px-3 py-1.5 text-xs text-danger">
      <span class="truncate">{{ groupsStore.promptErrorDetail ?? $t(`bot.errors.${groupsStore.promptError}`) }}</span>
      <button
        v-if="groupsStore.uncertainPromptText"
        type="button"
        data-test="group-retry-prompt-button"
        class="rounded-sm bg-raised text-fg hover:bg-surface-2 px-2 py-0.5 font-medium transition-colors"
        @click="handleRetry"
      >
        {{ $t("bot.prompt.retry") }}
      </button>
    </div>

    <div class="mb-2 flex items-center gap-2">
      <div class="relative">
        <button
          type="button"
          :ref="(el) => (targetDd.trigger = el as HTMLElement | null)"
          data-test="group-target-button"
          :disabled="disabled || groupsStore.hasUncertainPrompt"
          :aria-haspopup="true"
          :aria-expanded="targetDd.open"
          class="flex items-center gap-1.5 rounded-sm px-1 text-xs font-medium transition-colors disabled:opacity-50"
          :class="targetDd.open ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'"
          @click="toggleMenu"
        >
          <Users :size="13" class="text-accent" />
          <span class="max-w-[180px] truncate">{{ selectionLabel }}</span>
          <ChevronDown :size="12" class="text-fg-muted transition-transform" :class="targetDd.open ? 'rotate-180' : ''" />
        </button>
        <!-- One panel (unified §F): rows render in a slot (avatars + disabled notes);
             composer panels open upward. -->
        <DropdownPanel :dd="targetDd" tone="surface" width="w-64" placement="top"
                       :title='$t("group.target.sendTo")' test-id="group-target-menu"
                       :nav-count="navCount" @navigate="onNavSelect">
          <template #default="{ mobile }">
            <button type="button" data-test="group-target-lead"
                    class="flex w-full items-center gap-2 rounded-sm px-2 text-left text-sm"
                    :class="[mobile ? 'h-11' : 'h-8', 'text-fg']"
                    @click="pickLead">
              <AtSign :size="14" class="shrink-0 text-fg-muted" />
              <span class="flex-1 truncate font-medium">{{ $t("group.target.lead") }}</span>
            </button>
            <button v-if="automaticVisible" type="button" data-test="group-target-automatic"
                    class="flex w-full items-center gap-2 rounded-sm px-2 text-left text-sm"
                    :class="[mobile ? 'h-11' : 'h-8', 'text-fg']"
                    @click="pickAutomatic">
              <Bot :size="14" class="shrink-0 text-fg-muted" />
              <span class="min-w-0 flex-1 truncate font-medium">{{ $t("group.target.automatic") }}</span>
              <Check v-if="isAutomatic" :size="14" class="shrink-0 text-accent" />
            </button>
            <button type="button" data-test="group-target-everyone"
                    class="flex w-full items-center gap-2 rounded-sm px-2 text-left text-sm"
                    :class="[mobile ? 'h-11' : 'h-8', 'text-fg']"
                    @click="pickEveryone">
              <Users :size="14" class="shrink-0 text-fg-muted" />
              <span class="flex-1 truncate font-medium">{{ $t("group.target.everyone") }}</span>
              <Check v-if="isEveryone" :size="14" class="shrink-0 text-accent" />
            </button>
            <p class="px-2 pb-1 pt-2 text-xs text-fg-muted">{{ $t("group.target.selectMembers") }}</p>
            <button v-for="b in props.bots" :key="b.id"
                    :data-test="`group-target-member-${b.id}`"
                    :disabled="!b.enabled"
                    class="flex w-full items-center gap-2 rounded-sm px-2 text-left text-sm"
                    :class="[mobile ? 'h-11' : 'h-8', !b.enabled ? 'cursor-not-allowed text-fg-muted/50' : 'text-fg']"
                    @click="toggleMember(b.id)">
              <BotAvatar :avatar="b.avatar" :driver="driverFor(b)" :name="b.name" :size="24" static
                         :disabled="!b.enabled" :retired="b.retired" :class="!b.enabled ? 'opacity-50' : ''" />
              <span class="min-w-0 flex-1 truncate" :class="!b.enabled ? 'text-fg-muted' : 'text-fg'">{{ b.name }}</span>
              <span v-if="!b.enabled" class="shrink-0 text-xs text-fg-muted">{{ $t("bot.status.disabled") }}</span>
              <Check v-else-if="selectedIds.includes(b.id)" :size="14" class="shrink-0 text-accent" />
            </button>
            <p v-if="eligibleBots.length === 0" class="px-2 py-2 text-sm text-fg-muted">
              {{ $t("group.target.noEligible") }}
            </p>
          </template>
        </DropdownPanel>
      </div>
      <span class="hidden text-xs text-fg-muted sm:inline">{{ $t("group.target.hint") }}</span>
    </div>

    <ConversationComposer
      ref="composer"
      v-model="promptText"
      :busy="groupsStore.isRunActive"
      :disabled="disabled || groupsStore.promptInFlight || groupsStore.isRunActive || !groupsStore.topicReady"
      :sending="groupsStore.promptInFlight"
      :send-disabled="!canSend"
      :placeholder="$t('group.prompt.placeholder')"
      textarea-test-id="group-composer-textarea"
      send-test-id="group-send-prompt-button"
      stop-test-id="group-stop-run-button"
      @send="handleSend"
      @cancel="handleCancel"
      @keydown="onKeydown"
      @input="onInput"
      @caret="onCaret"
      @compositionstart="composing = true"
      @compositionend="onCompositionEnd"
      @blur="commitMentionAtBoundary"
    >
      <template #menus>
        <div
          v-if="slashHint"
          data-test="group-slash-hint"
          class="absolute bottom-full left-0 z-20 mb-2 w-full rounded-2xl bg-raised px-3 py-2 text-xs text-fg-muted shadow-float"
        >
          {{ $t("bot.errors.slashSelectMember") }}
        </div>
        <div
          v-else-if="slashMatches.length > 0"
          data-test="group-cmd-menu"
          class="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full overflow-y-auto rounded-lg bg-surface p-1 shadow-float"
        >
          <button
            v-for="(command, index) in slashMatches"
            :key="command.name"
            type="button"
            data-test="group-cmd-item"
            class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm"
            :class="index === cmdActiveIdx ? 'bg-surface-2' : 'hover:bg-surface-2'"
            @mousedown.prevent="pickSlash(command.name)"
          >
            <span class="font-medium text-fg">/{{ command.name }}</span>
            <span v-if="command.description" class="truncate text-xs text-fg-muted">{{ command.description }}</span>
          </button>
        </div>
        <div
          v-if="mentionMatches.length > 0"
          data-test="group-mention-menu"
          class="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full overflow-y-auto rounded-lg bg-surface p-1 shadow-float"
        >
          <button
            v-for="(member, index) in mentionMatches"
            :key="member.botId"
            type="button"
            data-test="group-mention-item"
            :data-bot-id="member.botId"
            class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm"
            :class="index === mentionActiveIdx ? 'bg-surface-2' : 'hover:bg-surface-2'"
            @mousedown.prevent="pickMention(member)"
          >
            <span class="min-w-0 flex-1 truncate font-medium text-fg">@{{ member.name }}</span>
            <span v-if="member.lead" class="shrink-0 text-xs text-accent">{{ $t("group.target.lead") }}</span>
            <span v-if="member.role" class="shrink-0 truncate text-xs text-fg-muted">{{ member.role }}</span>
            <span class="shrink-0 text-xs" :class="member.enabled ? 'text-fg-muted' : 'text-warning'">
              {{ member.enabled ? $t("bot.status.enabled") : $t("bot.status.disabled") }}
            </span>
            <span class="shrink-0 font-mono text-xs text-fg-muted">{{ member.botId }}</span>
          </button>
        </div>
      </template>
    </ConversationComposer>
  </div>
</template>
