<script setup lang="ts">
import { computed, nextTick, ref, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, Loader2, RotateCcw } from "lucide-vue-next";
import {
  MSG,
  isErrorPayload,
  type AgentMention,
  type ConversationCompletions,
  type PromptAttachmentRef,
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
import { useComposerStore } from "../stores/composer";
import ComposerAttachments from "./ComposerAttachments.vue";
import ComposerAttachPicker from "./ComposerAttachPicker.vue";
import ConversationComposer from "./ConversationComposer.vue";
import CompletionList, { type CompletionRow } from "./CompletionList.vue";
import CompletionMenu from "./CompletionMenu.vue";
import { useCompletionDismiss, useIsMobile } from "../lib/use-dropdown";
import { confirm } from "../lib/use-confirm";
import { pushToast } from "../lib/use-toasts";
import { randomUuid } from "../lib/random-id";

const props = defineProps<{
  disabled?: boolean;
  deliver?: (
    text: string,
    mentions: AgentMention[],
    media: PromptAttachmentRef[],
  ) => Promise<"accepted" | "rejected" | "uncertain" | "orphaned">;
}>();
const emit = defineEmits<{
  send: [text: string, mentions?: AgentMention[], media?: PromptAttachmentRef[]];
}>();
const { t } = useI18n();
const directBotsStore = useDirectBotsStore(),
  commandStore = useConversationCommandsStore(),
  drafts = useDirectComposerStore();
const attachments = useComposerStore();
const composer = ref<InstanceType<typeof ConversationComposer> | null>(null);
const composing = ref(false),
  caret = ref(0),
  collapsed = ref(true),
  cmdActiveIdx = ref(0),
  cmdDismissed = ref(false),
  page = ref(0);
/** Below lg the completion selector is a bottom sheet, not a popover. */
const isMobile = useIsMobile();
/** The composer card this menu belongs to; a pointerdown outside it dismisses. */
const rootEl = ref<HTMLElement | null>(null);
useCompletionDismiss(rootEl, () => menuOpen.value, () => { cmdDismissed.value = true; });
const scope = computed(() =>
  JSON.stringify([
    directBotsStore.instanceId,
    directBotsStore.activeConversationId,
    directBotsStore.activeTopicId,
    directBotsStore.selectedBotId,
  ]),
);
/** Attachment scope: one upload draft per instance + Bot conversation + Topic.
 *  Namespaced with "direct" so it can never collide with the session chat or
 *  Group composer scopes in the shared composer store. */
const attachKey = computed(() =>
  JSON.stringify(["direct", directBotsStore.instanceId, directBotsStore.activeConversationId, directBotsStore.activeTopicId, directBotsStore.selectedBotId]),
);
watch(attachKey, () => {
  if (directBotsStore.instanceId) attachments.bindInstance(directBotsStore.instanceId, attachKey.value);
}, { immediate: true });
const readyMedia = computed(() => attachments.pending.some((entry) => entry.status === "ready"));
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
  bot = computed(() => directBotsStore.currentBot),
  isBotDisabled = computed(() => (bot.value ? !bot.value.enabled : false));
const blocked = computed(
  () =>
    !!props.disabled ||
    isBotDisabled.value ||
    isPromptInFlight.value ||
    isTopicRecovering.value,
);

/**
 * Clear the current topic's context from the composer's action row.
 *
 * A Bot's session is owned by its Topic, so this is the Topic-level clear rather than
 * the ordinary session reset: the Topic stays, its `contextGeneration` advances, and the
 * Bot's runtime binding is rebuilt on the next send. The same call backs the Topic
 * menu's "clear default topic".
 */
const clearingContext = ref(false);
const canClearContext = computed(
  () =>
    !!directBotsStore.instanceId &&
    !!directBotsStore.activeConversationId &&
    !!directBotsStore.activeTopicId &&
    !blocked.value &&
    !isRunActive.value &&
    !clearingContext.value,
);
async function clearContext(): Promise<void> {
  const instanceId = directBotsStore.instanceId;
  const conversationId = directBotsStore.activeConversationId;
  const topicId = directBotsStore.activeTopicId;
  if (!canClearContext.value || !instanceId || !conversationId || !topicId) return;
  const ok = await confirm({
    title: t("chat.clearContext.title"),
    message: t("chat.clearContext.botBody"),
    confirmLabel: t("chat.clearContext.confirm"),
    tone: "danger",
  });
  if (!ok) return;
  clearingContext.value = true;
  try {
    // releaseBindings: the binding still names the old runtime, and leaving it in place
    // is exactly what keeps a broken session unrecoverable.
    await directBotsStore.clearTopic(instanceId, conversationId, topicId, randomUuid(), true);
    pushToast("success", "chat.clearContext.done");
  } catch (error: unknown) {
    pushToast("error", error instanceof Error ? error.message : String(error));
  } finally {
    clearingContext.value = false;
  }
}
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
          detail: [m.agent, m.workspace].filter(Boolean).join(" · "),
          command: undefined as string | undefined,
          kind: undefined,
          handle: m.handle,
        })),
);
const rows = computed(() =>
  candidates.value.slice(page.value * 8, page.value * 8 + 8),
);

/** The current page as list rows: one shape for slash commands and mentions. */
const completionRows = computed<CompletionRow[]>(() =>
  rows.value.map((row) => ({
    key: row.key,
    label: row.label,
    detail: row.detail,
    badge: row.kind === "skill" ? t("bot.prompt.skillCompletion") : undefined,
    testId: "direct-cmd-item",
  })),
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
/** The sheet closed (scrim, ✕, back gesture): dismiss the menu the way Escape
 *  does — the half-typed text stays — and hand focus back to the textarea. */
function closeSelector(): void {
  cmdDismissed.value = true;
  void nextTick(() => composer.value?.focus());
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
/**
 * Stop from the composer, matching how an ordinary session's Stop behaves: the
 * running turn ends and anything waiting behind it is retired. A Direct Bot keeps
 * this control in the composer rather than in the status bar, because the reader is
 * looking at the input they just used — the status bar's "Stop all" is the Group
 * affordance, where several members share one Run.
 */
async function stopRun(): Promise<void> {
  await directBotsStore.stopCurrentAndQueued();
}

async function handleSend(): Promise<void> {
  if (blocked.value || composing.value || attachments.uploading) return;
  const key = scope.value,
    text = promptText.value,
    staged = attachments.snapshot(attachKey.value),
    stagedScopeKey = attachKey.value;
  if (!text.trim() && staged.media.length === 0) return;
  const mentions = structuredClone(
    drafts.get(key).mentions.map((m) => ({
      range: [...m.range] as [number, number],
      handle: m.handle,
    })),
  );
  if (props.deliver) {
    const outcome = await props.deliver(text, mentions, staged.media);
    // Accepted: the transcript owns the media. Uncertain keeps the chips so a
    // resend replays the identical tuple (same requestId, server-deduped); a
    // definitive refusal keeps them editable for a corrected resend.
    if (outcome === "accepted") {
      attachments.consume(stagedScopeKey, staged.ids);
      drafts.clear(key, text, mentions);
    }
  } else {
    emit("send", text, mentions, staged.media);
    attachments.consume(stagedScopeKey, staged.ids);
  }
  if (key === scope.value) {
    cmdDismissed.value = false;
  }
}
async function onPaste(e: ClipboardEvent): Promise<void> {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length === 0 || blocked.value) return;
  e.preventDefault();
  await attachments.addFiles(files, attachKey.value);
}
async function onDrop(e: DragEvent): Promise<void> {
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0 || blocked.value) return;
  e.preventDefault();
  await attachments.addFiles(files, attachKey.value);
}
function handleRetry(): void {
  void handleSend();
}
function onInput(): void {
  cmdDismissed.value = false;
  cmdActiveIdx.value = 0;
  page.value = 0;
}
/** Put text in the draft without sending it. The empty Bot page's starter chips
 *  call this: a tap fills the composer so the user can edit or add to it. */
function fillDraft(text: string): void {
  promptText.value = text;
  caret.value = text.length;
  cmdDismissed.value = true;
}
/** Whether the composer currently holds any draft text. The empty Bot page
 *  hides its starter chips while this is true so a tap can never clobber one. */
const hasDraft = computed(() => promptText.value.length > 0);
/** Move keyboard focus into the textarea. Starter chips call this after filling
 *  so the user can keep typing instead of tapping the field. */
function focusInput(): void {
  composer.value?.focus();
}
defineExpose({ fillDraft, focusInput, hasDraft });
</script>
<template>
  <div ref="rootEl" class="shrink-0 bg-gradient-to-t from-bg to-transparent px-2.5 lg:px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-1.5">
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
      class="mb-2 flex items-center justify-between gap-2 rounded-lg bg-danger/10 px-3 py-1.5 text-xs text-danger-text"
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


    <ConversationComposer
      ref="composer"
      v-model="promptText"
      :busy="isRunActive"
      :disabled="blocked"
      :sending="isPromptInFlight"
      :has-attachments="readyMedia"
      :attachments-send-disabled="attachments.uploading"
      :send-disabled="false"
      :placeholder="composerPlaceholder"
      send-test-id="send-prompt-button"
      stop-test-id="cancel-bot-turn"
      allow-stop
      combobox
      combobox-list-id="direct-completion-menu"
      :combobox-expanded="menuOpen"
      :combobox-active-id="menuOpen && rows.length ? 'direct-completion-' + cmdActiveIdx : undefined"
      @send="handleSend"
      @cancel="stopRun"
      @keydown="onKeydown"
      @input="onInput"
      @paste="onPaste"
      @drop="onDrop"
      @caret="updateCaret"
      @compositionstart="composing = true"
      @compositionend="
        composing = false;
        onInput();
      "
    >
      <template #attachments>
        <ComposerAttachments
          v-if="directBotsStore.instanceId"
          :scope-key="attachKey"
          :disabled="blocked"
        />
      </template>
      <template #actions>
        <button
          type="button"
          data-test="clear-context-btn"
          :title="$t('chat.clearContext.title')"
          :aria-label="$t('chat.clearContext.title')"
          :disabled="!canClearContext"
          class="flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          @click="clearContext"
        >
          <RotateCcw :size="15" />
        </button>
        <ComposerAttachPicker
          v-if="directBotsStore.instanceId"
          :scope-key="attachKey"
          :disabled="blocked"
        />
      </template>
      <template #menus>
      <CompletionMenu
        :open="menuOpen"
        :mobile="isMobile"
        :title="$t('bot.prompt.completions')"
        sheet-test-id="direct-cmd-sheet"
        panel-class="max-h-80"
        @close="closeSelector"
      >
        <template #default="{ mobile }">
          <CompletionList
            list-id="direct-completion-menu"
            :aria-label="$t('bot.prompt.completions')"
            test-id="direct-cmd-menu"
            item-test-id="direct-cmd-item"
            item-id-prefix="direct-completion-"
            :rows="completionRows"
            :active-index="cmdActiveIdx"
            :mobile="mobile"
            :status-text="$t('bot.prompt.completion' + status)"
            @pick="pickRow"
          >
            <button
              v-if="more"
              type="button"
              class="text-left text-xs text-accent-text"
              :class="mobile ? 'flex min-h-[46px] w-full items-center px-3' : 'px-3 py-2'"
              @pointerdown.prevent
              @click="nextPage"
            >
              {{ $t("bot.prompt.moreCompletions") }}
            </button>
            <button
              v-if="status === 'error' || status === 'loading' || status === 'unavailable'"
              type="button"
              class="text-left text-xs text-accent-text"
              :class="mobile ? 'flex min-h-[46px] w-full items-center px-3' : 'px-3 py-2'"
              @pointerdown.prevent
              @click="refresh()"
            >
              {{ $t("bot.prompt.retry") }}
            </button>
          </CompletionList>
        </template>
      </CompletionMenu>
      </template>
    </ConversationComposer>
  </div>
</template>
