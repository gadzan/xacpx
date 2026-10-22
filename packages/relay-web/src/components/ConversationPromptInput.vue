<script setup lang="ts">
import { computed, nextTick, ref, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, Loader2, RotateCcw } from "lucide-vue-next";
import {
  MSG,
  isErrorPayload,
  type AgentMention,
  type ConversationCompletions,
} from "@ganglion/xacpx-relay-protocol";
import {
  completionKey,
  replaceRange,
  slashQuery,
  mentionQueryAt,
  editMentions,
} from "../lib/composer-completion";
import { api } from "../api/client";
import { useConversationCommandsStore } from "../stores/conversation-commands";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useDirectComposerStore } from "../stores/direct-composer";
import ConversationComposer from "./ConversationComposer.vue";
import { mergeRecoveredDraft, sourceRunPrompt } from "../lib/composer-run-actions";
const props = defineProps<{
  disabled?: boolean;
  deliver?: (
    text: string,
    mentions: AgentMention[],
  ) => Promise<"accepted" | "rejected" | "uncertain" | "orphaned">;
}>();
const emit = defineEmits<{
  send: [text: string, mentions?: AgentMention[]];
  cancel: [];
}>();
const { t } = useI18n();
const directBotsStore = useDirectBotsStore(),
  commandStore = useConversationCommandsStore(),
  drafts = useDirectComposerStore();
const composer = ref<InstanceType<typeof ConversationComposer> | null>(null);
const composing = ref(false),
  caret = ref(0),
  collapsed = ref(true),
  cmdActiveIdx = ref(0),
  cmdDismissed = ref(false),
  page = ref(0);
const actionBusy = ref(false);
const actionError = ref<string | null>(null);
const restoreNotice = ref<string | null>(null);
const scope = computed(() =>
  JSON.stringify([
    directBotsStore.instanceId,
    directBotsStore.activeConversationId,
    directBotsStore.activeTopicId,
    directBotsStore.selectedBotId,
  ]),
);
const promptText = computed({
  get: () => drafts.get(scope.value).text,
  set: (text) => {
    const old = drafts.get(scope.value);
    drafts.set(scope.value, text, editMentions(old.text, text, old.mentions));
  },
});
const isRunActive = computed(() => directBotsStore.isRunActive),
  isTopicRecovering = computed(() => !directBotsStore.topicReady),
  // A topicless Bot's first send is in flight from the click, while its
  // Default Topic is still being created.
  isPromptInFlight = computed(() => directBotsStore.promptInFlight || directBotsStore.firstSendPending),
  isCancelling = computed(() => !!directBotsStore.cancellingRunId),
  bot = computed(() => directBotsStore.currentBot),
  isBotDisabled = computed(() => (bot.value ? !bot.value.enabled : false));
const blocked = computed(
  () =>
    !!props.disabled ||
    isBotDisabled.value ||
    isPromptInFlight.value ||
    isTopicRecovering.value,
);
const composerPlaceholder = computed(() =>
  isBotDisabled.value
    ? t("bot.prompt.botDisabledPlaceholder")
    : isTopicRecovering.value
      ? t("bot.prompt.recoveringPlaceholder")
      : isRunActive.value
        ? t("bot.prompt.runActivePlaceholder")
        : t("bot.prompt.placeholder"),
);
const snapshot = ref<ConversationCompletions | null>(null),
  fetchStatus = ref<"loading" | "unavailable" | "error">("loading");
const slashCommands = computed(() => {
  const {
    instanceId,
    activeConversationId: conversationId,
    activeTopicId: topicId,
    selectedBotId: botId,
  } = directBotsStore;
  if (!instanceId || !conversationId || !topicId || !botId) return [];
  const live = commandStore.commandsFor({
    instanceId,
    conversationId,
    topicId,
    botId,
  });
  return snapshot.value ? snapshot.value.commands.items : live;
});
const slash = computed(() => slashQuery(promptText.value, caret.value));
const mention = computed(() => mentionQueryAt(promptText.value, caret.value));
const menuKind = computed(() =>
  slash.value ? "slash" : mention.value ? "mention" : "closed",
);
const menuOpen = computed(
  () =>
    menuKind.value !== "closed" &&
    !cmdDismissed.value &&
    !composing.value &&
    !blocked.value &&
    collapsed.value,
);
const referenceLimit = computed(
  () =>
    menuKind.value === "mention" &&
    drafts.get(scope.value).mentions.length >= 16,
);
const candidates = computed(() =>
  referenceLimit.value
    ? []
    : menuKind.value === "slash"
      ? slashCommands.value
          .filter((c) =>
            c.name.toLowerCase().startsWith(slash.value?.query ?? ""),
          )
          .map((c) => ({
            key: c.name,
            label: "/" + c.name,
            detail: c.description ?? "",
            command: c.name,
            kind: c.kind,
            handle: undefined as string | undefined,
          }))
      : (snapshot.value?.mentions.items ?? []).map((m) => ({
          key: m.handle,
          label: "@" + m.displayName,
          detail: [m.agent, m.workspace, m.botId?.slice(-8)].filter(Boolean).join(" · "),
          command: undefined as string | undefined,
          kind: undefined,
          handle: m.handle,
        })),
);
const rows = computed(() =>
  candidates.value.slice(page.value * 8, page.value * 8 + 8),
);
const more = computed(
  () =>
    (page.value + 1) * 8 < candidates.value.length ||
    (snapshot.value?.mentions.nextCursor !== undefined &&
      menuKind.value === "mention"),
);
const status = computed(() => {
  const {
    instanceId,
    activeConversationId: conversationId,
    activeTopicId: topicId,
    selectedBotId: botId,
  } = directBotsStore;
  const advertised =
    instanceId &&
    conversationId &&
    topicId &&
    botId &&
    commandStore.hasAdvertisement({
      instanceId,
      conversationId,
      topicId,
      botId,
    });
  if (referenceLimit.value) return "limit";
  return !snapshot.value && menuKind.value === "slash" && advertised
    ? "ready"
    : (snapshot.value?.[menuKind.value === "slash" ? "commands" : "mentions"]
        .status ?? fetchStatus.value);
});
let generation = 0,
  retryTimer: ReturnType<typeof setTimeout> | undefined;
async function refresh(cursor = 0): Promise<void> {
  const ticket = ++generation,
    key = scope.value;
  const {
    instanceId,
    activeConversationId: conversationId,
    activeTopicId: topicId,
  } = directBotsStore;
  if (
    !instanceId ||
    !conversationId ||
    !topicId ||
    menuKind.value === "closed" ||
    blocked.value
  )
    return;
  fetchStatus.value = "loading";
  try {
    const result = await api.rpc<ConversationCompletions>(
      instanceId,
      MSG.conversationCompletionsGet,
      {
        conversationId,
        topicId,
        ...(menuKind.value === "mention" && mention.value
          ? { query: mention.value.query, cursor }
          : {}),
      },
    );
    if (ticket !== generation || key !== scope.value) return;
    if (
      isErrorPayload(result) ||
      result.version !== 1 ||
      result.scope.conversationId !== conversationId ||
      result.scope.topicId !== topicId ||
      result.scope.botId !== directBotsStore.selectedBotId ||
      !Array.isArray(result.commands?.items) ||
      !Array.isArray(result.mentions?.items)
    ) {
      snapshot.value = null;
      fetchStatus.value = "unavailable";
      return;
    }
    snapshot.value =
      cursor && snapshot.value
        ? {
            ...result,
            mentions: {
              ...result.mentions,
              items: [
                ...snapshot.value.mentions.items,
                ...result.mentions.items,
              ],
            },
          }
        : result;
    // Only the slash menu waits on command discovery; mention results are
    // final, and re-polling would reset pagination loaded via "more".
    if (menuKind.value === "slash" && result.commands.status === "loading") {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (ticket === generation && key === scope.value) void refresh();
      }, 1500);
    }
  } catch {
    if (ticket === generation && key === scope.value) {
      snapshot.value = null;
      fetchStatus.value = "error";
    }
  }
}
watch(
  () => [
    scope.value,
    bot.value?.profileRevision,
    commandStore.epochFor(directBotsStore.instanceId ?? ""),
    menuKind.value,
    mention.value?.query,
  ],
  () => {
    generation++;
    clearTimeout(retryTimer);
    snapshot.value = null;
    page.value = 0;
    cmdActiveIdx.value = 0;
    if (menuKind.value !== "closed") void refresh();
  },
);
watch(scope, () => {
  cmdDismissed.value = false;
  caret.value = promptText.value.length;
  void nextTick(onInput);
});
onBeforeUnmount(() => {
  generation++;
  clearTimeout(retryTimer);
});
function updateCaret(selection: { start: number; end: number }): void {
  caret.value = selection.start;
  collapsed.value = selection.start === selection.end;
}
function nextPage(): void {
  if ((page.value + 1) * 8 < candidates.value.length) {
    page.value++;
    cmdActiveIdx.value = 0;
  } else if (snapshot.value?.mentions.nextCursor !== undefined)
    void refresh(snapshot.value.mentions.nextCursor).then(() => {
      page.value++;
      cmdActiveIdx.value = 0;
    });
}
function pickRow(index: number): void {
  const row = rows.value[index],
    query = menuKind.value === "slash" ? slash.value : mention.value;
  if (!row || !query || blocked.value || !collapsed.value || composing.value)
    return;
  if (row.handle && drafts.get(scope.value).mentions.length >= 16) return;
  const label = row.command ? "/" + row.command : row.label;
  const replaced = replaceRange(promptText.value, query.range, label + " ");
  promptText.value = replaced.text;
  if (row.handle) {
    const old = drafts.get(scope.value);
    if (old.mentions.length < 16)
      drafts.set(
        scope.value,
        old.text,
        [
          ...old.mentions,
          {
            range: [query.range.start, query.range.start + label.length] as [
              number,
              number,
            ],
            handle: row.handle,
          },
        ].sort((a, b) => a.range[0] - b.range[0]),
      );
  }
  cmdDismissed.value = true;
  caret.value = replaced.cursor;
  void nextTick(() => {
    composer.value?.focus();
    composer.value?.setSelectionRange(replaced.cursor, replaced.cursor);
  });
}
function onKeydown(e: KeyboardEvent): void {
  const action = completionKey({
    key: e.key,
    shiftKey: e.shiftKey,
    isComposing: e.isComposing,
    composing: composing.value,
    menu: menuOpen.value ? menuKind.value : "closed",
    itemCount: rows.value.length,
    activeIndex: cmdActiveIdx.value,
    holdKeys: menuOpen.value,
    collapsedCaret: collapsed.value,
    busy: blocked.value,
    caretAtStart: false,
    historyArmed: false,
  });
  if (action.type === "ignore" || action.type === "passthrough") return;
  if (action.type === "move") {
    cmdActiveIdx.value = action.index;
    e.preventDefault();
    return;
  }
  if (action.type === "commit") {
    pickRow(action.index);
    e.preventDefault();
    return;
  }
  if (action.type === "dismiss") {
    cmdDismissed.value = true;
    e.preventDefault();
    return;
  }
  if (action.type === "blocked") {
    e.preventDefault();
    return;
  }
  if (action.type === "send") {
    e.preventDefault();
    void handleSend();
  }
}
async function handleSend(): Promise<void> {
  if (blocked.value || actionBusy.value || isRunActive.value || !promptText.value.trim() || composing.value) return;
  const key = scope.value,
    text = promptText.value,
    mentions = structuredClone(
      drafts.get(key).mentions.map((m) => ({
        range: [...m.range] as [number, number],
        handle: m.handle,
      })),
    );
  if (props.deliver) {
    const outcome = await props.deliver(text, mentions);
    if (outcome === "accepted") drafts.clear(key, text, mentions);
  } else emit("send", text, mentions);
  if (key === scope.value) {
    cmdDismissed.value = false;
  }
}
async function handleCancel(): Promise<void> {
  await runAction("stop");
}

async function runAction(action: "stop" | "restore" | "takeover"): Promise<void> {
  const run = directBotsStore.activeRun;
  const instanceId = directBotsStore.instanceId;
  const botId = directBotsStore.selectedBotId;
  if (!run || !instanceId || actionBusy.value || isCancelling.value) return;
  const key = scope.value;
  const snapshot = drafts.get(key);
  if (action === "takeover" && !snapshot.text.trim()) return;
  actionBusy.value = true;
  actionError.value = null;
  try {
    const recovered = action === "restore" ? await sourceRunPrompt(instanceId, run, directBotsStore.messages) : null;
    if (key !== scope.value) return;
    if (action === "restore" && recovered === null) { actionError.value = t("collaboration.promptUnavailable"); return; }
    const outcome = await directBotsStore.cancelCurrentRun({ runId: run.id });
    if (key !== scope.value || outcome.scope?.instanceId !== instanceId
      || outcome.scope.conversationId !== run.conversationId || outcome.scope.topicId !== run.topicId
      || outcome.scope.botId !== botId || outcome.runId !== run.id) return;
    if (outcome.status !== "cancelled" && outcome.status !== "terminal") { actionError.value = t("collaboration.stopUnconfirmed"); return; }
    if (action === "restore" && recovered !== null) {
      promptText.value = mergeRecoveredDraft(promptText.value, recovered);
      restoreNotice.value = t("collaboration.restored");
      await nextTick();
      composer.value?.focus();
    } else if (action === "takeover") {
      if (drafts.get(key) !== snapshot) return;
      actionBusy.value = false;
      await handleSend();
    }
  } catch { actionError.value = t("collaboration.stopUnconfirmed"); }
  finally { actionBusy.value = false; }
}

watch(scope, () => { actionError.value = null; restoreNotice.value = null; });
function handleRetry(): void {
  void handleSend();
}
function onInput(): void {
  cmdDismissed.value = false;
  cmdActiveIdx.value = 0;
  page.value = 0;
}
</script>
<template>
  <div class="shrink-0 bg-gradient-to-t from-bg to-transparent px-2 lg:px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-1.5">
    <!-- Disabled bot warning -->
    <div
      v-if="isBotDisabled"
      class="mb-2 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-1.5 text-xs text-warning"
    >
      <AlertCircle :size="14" class="shrink-0" />
      <span>{{ $t("bot.prompt.botDisabledWarning") }}</span>
    </div>

    <!-- Cancellation uncertainty (separate from prompt errors; no retry target) -->
    <div
      v-else-if="directBotsStore.cancelError"
      class="mb-2 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-1.5 text-xs text-warning"
    >
      <AlertCircle :size="14" class="shrink-0" />
      <span class="truncate">{{
        $t(`bot.errors.${directBotsStore.cancelError}`)
      }}</span>
    </div>

    <!-- Error Banner & Retry -->
    <div
      v-else-if="directBotsStore.promptError"
      class="mb-2 flex items-center justify-between gap-2 rounded-lg bg-danger/10 px-3 py-1.5 text-xs text-danger"
    >
      <div class="flex items-center gap-2 min-w-0">
        <AlertCircle :size="14" class="shrink-0" />
        <span class="truncate">{{
          directBotsStore.promptErrorDetail ??
          $t(`bot.errors.${directBotsStore.promptError}`)
        }}</span>
      </div>
      <button
        type="button"
        class="flex items-center gap-1 rounded-sm bg-raised text-fg hover:bg-surface-2 px-2 py-0.5 font-medium transition-colors"
        @click="handleRetry"
      >
        <RotateCcw :size="12" />
        <span>{{ $t("bot.prompt.retry") }}</span>
      </button>
    </div>

    <p v-if="actionError" role="alert" class="mb-2 text-xs text-danger">{{ actionError }}</p>
    <p v-if="restoreNotice" role="status" class="mb-2 text-xs text-fg-muted">{{ restoreNotice }}</p>
    <div v-if="isRunActive" class="mb-2 flex items-center gap-2 text-xs">
      <button type="button" class="min-h-11 rounded-lg px-2 text-danger hover:bg-raised disabled:opacity-50" :disabled="actionBusy || isCancelling" @click="runAction('stop')">{{ $t('group.detail.stopRun') }}</button>
      <button type="button" class="min-h-11 rounded-lg px-2 hover:bg-raised disabled:opacity-50" :disabled="actionBusy || isCancelling" @click="runAction('restore')">{{ $t('collaboration.stopRestore') }}</button>
      <button type="button" class="min-h-11 rounded-lg px-2 text-accent hover:bg-raised disabled:opacity-50" :title="$t('collaboration.takeoverHint')" :disabled="actionBusy || isCancelling || !promptText.trim()" @click="runAction('takeover')">{{ $t('collaboration.takeover') }}</button>
    </div>
    <ConversationComposer
      ref="composer"
      v-model="promptText"
      :busy="isRunActive"
      :disabled="blocked"
      :sending="isPromptInFlight"
      :cancelling="isCancelling || actionBusy"
      :placeholder="composerPlaceholder"
      send-test-id="send-prompt-button"
      stop-test-id="stop-run-button"
      combobox
      combobox-list-id="direct-completion-menu"
      :combobox-expanded="menuOpen"
      :combobox-active-id="menuOpen && rows.length ? 'direct-completion-' + cmdActiveIdx : undefined"
      @send="handleSend"
      @cancel="handleCancel"
      @keydown="onKeydown"
      @input="onInput"
      @caret="updateCaret"
      @compositionstart="composing = true"
      @compositionend="
        composing = false;
        onInput();
      "
    >
      <template #menus>
        <div
          v-if="menuOpen"
          id="direct-completion-menu"
          role="listbox"
          :aria-label="$t('bot.prompt.completions')"
          data-test="direct-cmd-menu"
          class="absolute bottom-full left-0 z-20 mb-2 max-h-80 w-full overflow-y-auto rounded-lg bg-surface p-1 shadow-float"
        >
          <button
            v-for="(row, index) in rows"
            :id="'direct-completion-' + index"
            :key="row.key"
            type="button"
            role="option"
            :aria-selected="index === cmdActiveIdx"
            data-test="direct-cmd-item"
            class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm"
            :class="index === cmdActiveIdx ? 'bg-surface-2' : 'hover:bg-surface-2'"
            @pointerdown.prevent
            @click="pickRow(index)"
          >
            <span v-if="row.kind === 'skill'" class="text-accent">{{
              $t("bot.prompt.skillCompletion")
            }}</span>
            <span class="font-medium text-fg">{{ row.label }}</span
            ><span class="truncate text-fg-muted">{{ row.detail }}</span>
          </button>
          <div
            v-if="!rows.length"
            role="status"
            class="px-3 py-2 text-xs text-fg-muted"
          >
            {{ $t("bot.prompt.completion" + status) }}
          </div>
          <button
            v-if="more"
            type="button"
            class="px-3 py-2 text-xs text-accent"
            @pointerdown.prevent
            @click="nextPage"
          >
            {{ $t("bot.prompt.moreCompletions") }}
          </button>
          <button
            v-if="
              status === 'error' ||
              status === 'loading' ||
              status === 'unavailable'
            "
            type="button"
            class="px-3 py-2 text-xs text-accent"
            @pointerdown.prevent
            @click="refresh()"
          >
            {{ $t("bot.prompt.retry") }}
          </button>
        </div>
      </template>
    </ConversationComposer>
  </div>
</template>
