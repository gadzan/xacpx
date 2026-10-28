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
import { groupDraftKey, loadDraft, saveDraft } from "../lib/composer-drafts";
import ComposerConfirmDialog from "./ComposerConfirmDialog.vue";
import { mergeRecoveredDraft, sourceRunPrompt } from "../lib/composer-run-actions";
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
  /** The Group has zero Topics: the pane's "Create first Topic" CTA is the only
   *  primary action, so the member target picker and its hint are not mounted
   *  and the (disabled) composer says why. */
  needsFirstTopic?: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
  cancel: [];
}>();

const { t } = useI18n();
const groupsStore = useGroupsStore();
const instancesStore = useInstancesStore();
const commandStore = useConversationCommandsStore();
/** One draft per Group + Topic, persisted through the shared composer-drafts store. */
const draftKey = computed(() =>
  groupDraftKey(props.instanceId ?? groupsStore.instanceId, groupsStore.activeConversationId, groupsStore.activeTopicId),
);
const promptText = ref(loadDraft(draftKey.value));
/** The draft a send is waiting on. While its outcome is pending the text belongs
 *  to the prompt, not to the composer (accepted → transcript, uncertain → Retry),
 *  so leaving that Topic must not keep a copy that would later resurface. */
let inFlightDraft: { key: string; text: string } | null = null;
/** True while a Group/Topic switch swaps the textarea contents: those writes are
 *  not user edits and must not be persisted under the new key. */
let swappingDraft = false;
/** Stop / stop-restore / takeover share one fence: a second click while the
 *  store reports the run as cancelling is a no-op, never a second RPC. */
const actionBusy = ref(false);
const actionError = ref<string | null>(null);
const restoreNotice = ref<string | null>(null);
interface EveryoneConfirmation {
  key: string;
  revision: number;
  recipientIds: string[];
  text: string;
  unresolvedConfirmed: boolean;
}
const everyoneConfirm = ref<EveryoneConfirmation | null>(null);
/** Revision of the draft text, bumped on every user edit. The everyone dialog
 *  snapshots it so a typed change invalidates the frozen recipient list. */
const draftRevision = ref(0);
const composer = ref<InstanceType<typeof ConversationComposer> | null>(null);
const targetDd = useDropdown();
const composing = ref(false);
const collapsedCaret = ref(true);
const cmdActiveIdx = ref(0);
const cmdDismissed = ref(false);
const mentionActiveIdx = ref(0);
const mentionDismissed = ref(false);
const mentionBindings = ref<MentionBinding[]>([]);
const mentionOwned = ref(false);
const unresolvedConfirm = ref<{ key: string; text: string; target: string } | null>(null);
const sendBusy = ref(false);

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

// Every edit is persisted under the current Group + Topic, so a draft survives
// switching away (and a tab reload). Sync, so an edit is always filed under the
// key it was typed against.
watch(promptText, (text) => {
  if (swappingDraft) return;
  saveDraft(draftKey.value, text);
  draftRevision.value += 1;
  actionError.value = null;
  restoreNotice.value = null;
  // A typed change invalidates a frozen everyone confirmation; the dialog must
  // refresh its recipient snapshot, never submit a stale list.
  if (everyoneConfirm.value && (everyoneConfirm.value.key !== draftKey.value || everyoneConfirm.value.text !== text)) {
    everyoneConfirm.value = null;
  }
}, { flush: "sync" });

// A Group/Topic switch swaps in that Group + Topic's own draft. The derived
// mention suppression and menus reset with the swap (otherwise the first mention
// in the next draft is ignored). `switchTopic()` sets `topicReady=false` at the
// same time, which disables the textarea, so the user cannot type in between.
// A rejected or orphaned send keeps its source draft: only a draft that matches
// the in-flight text is dropped, never whatever the user typed meanwhile.
watch(draftKey, (next, prev) => {
  swappingDraft = true;
  try {
    // The Topic we are leaving has a send in flight: its text is owned by that
    // prompt, so drop the stored copy instead of restoring it later as a draft.
    if (prev && inFlightDraft?.key === prev && loadDraft(prev) === inFlightDraft.text) {
      saveDraft(prev, "");
    }
    clearSentDraft();
    actionError.value = null;
    restoreNotice.value = null;
    everyoneConfirm.value = null;
    unresolvedConfirm.value = null;
    promptText.value = loadDraft(next);
    draftRevision.value += 1;
  } finally {
    swappingDraft = false;
  }
}, { flush: "sync" });

/** Eligible everyone recipients in live membership order: enabled members only.
 *  Names come from the real catalog rows; a missing row falls back to the id so
 *  the confirm dialog never invents a display name. */
const everyoneRecipients = computed<Array<{ id: string; name: string; lead: boolean }>>(() => {
  const group = groupsStore.currentGroup;
  if (!group) return [];
  const byId = new Map(props.bots.map((b) => [b.id, b] as const));
  return group.botIds
    .filter((id) => byId.get(id)?.enabled === true)
    .map((id) => ({ id, name: byId.get(id)?.name ?? id, lead: group.leadBotId === id }));
});

function memberUnavailableReason(bot: BotSummaryDto): string | null {
  if (bot.retired) return t("bot.status.disabled");
  const instance = instancesStore.byId(props.instanceId ?? groupsStore.instanceId ?? "");
  if (instance && (!instance.agents.some(agent => agent.name === bot.agent)
    || !instance.workspaces.some(workspace => workspace.name === bot.workspace))) return t("group.target.noRuntime");
  return bot.enabled ? null : t("bot.status.disabled");
}

function toggleMenu(): void {
  if (props.disabled) return;
  targetDd.toggle();
}

function closeMenu(): void {
  targetDd.closeMenu();
}

/** Unavailable rows retain keyboard focus and explain why activation is ignored. */
const navRows = computed<Array<() => void>>(() => {
  const rows: Array<() => void> = [() => pickLead()];
  if (automaticVisible.value) rows.push(() => pickAutomatic());
  rows.push(() => pickEveryone());
  for (const b of props.bots) {
    rows.push(() => toggleMember(b.id));
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
  const bot = props.bots.find(row => row.id === botId);
  if (!bot || memberUnavailableReason(bot)) return;
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
    enabled: memberUnavailableReason(bot) === null,
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
  if (!member.enabled) return;
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
  && !groupsStore.cancellingRunId
  && !groupsStore.isRunActive
  && groupsStore.topicReady
  // A fresh send is refused while a previous prompt's outcome is unknown: the
  // only way forward is replaying that prompt's frozen tuple.
  && !groupsStore.hasUncertainPrompt);

/** Final send guard: evaluated after any pending mention has been committed. */
const canSend = computed(() => baseCanSend.value
  && groupsStore.targetResolvable
  && !sendBusy.value
  && promptText.value.trim().length > 0);

async function handleSend(confirmedEveryone?: EveryoneConfirmation, confirmedUnresolved = false): Promise<void> {
  if (sendBusy.value || !baseCanSend.value) {
    // Refuse before touching the draft: the store reports why (targetRequired /
    // targetEmpty), and clearing the textarea would throw the typed message away
    // with no recoverable request id and no Retry content.
    groupsStore.reportTargetProblem();
    return;
  }
  if (confirmedEveryone && (confirmedEveryone.key !== draftKey.value
    || confirmedEveryone.text !== promptText.value || confirmedEveryone.revision !== draftRevision.value
    || !isEveryone.value)) { everyoneConfirm.value = null; return; }
  const text = promptText.value.trim();
  if (!text) return;
  if (slashBroadcastBlocked(text)) {
    groupsStore.promptError = "slashSelectMember";
    groupsStore.promptErrorDetail = null;
    return;
  }
  // The token under the caret is now final, so the structured target must
  // reflect it before the store resolves the send target.
  const resolved = commitMentionAtBoundary();
  confirmedUnresolved ||= confirmedEveryone?.unresolvedConfirmed === true;
  if (!resolved && !confirmedUnresolved) {
    unresolvedConfirm.value = { key: draftKey.value, text: promptText.value, target: JSON.stringify(selection.value) };
    return;
  }
  // Re-check after the boundary commit: the mention is what makes an empty
  // target valid for this very send, and entering text with no resolvable
  // target (e.g. deselected all members and typed nothing mentionable) must
  // surface the translated banner — not a send the local store refuses.
  if (!groupsStore.targetResolvable) {
    groupsStore.reportTargetProblem();
    return;
  }
  if (isEveryone.value) {
    const recipientIds = everyoneRecipients.value.map(member => member.id);
    if (!recipientIds.length) { groupsStore.promptError = "targetEmpty"; return; }
    const snapshot = { key: draftKey.value, revision: draftRevision.value, recipientIds, text: promptText.value, unresolvedConfirmed: confirmedUnresolved };
    if (!confirmedEveryone || JSON.stringify(confirmedEveryone) !== JSON.stringify(snapshot)) {
      everyoneConfirm.value = snapshot;
      return;
    }
    groupsStore.setTarget({ mode: "members", botIds: recipientIds });
  }
  everyoneConfirm.value = null;
  unresolvedConfirm.value = null;
  sendBusy.value = true;
  // The parent resolves the send against the store and reports the outcome, so
  // the draft decision uses the real result: an accepted prompt is in the
  // transcript, an uncertain one is replayable via Retry, but a definitive
  // refusal has neither and must leave the typed text in place.
  const sent = { key: draftKey.value, text: promptText.value };
  inFlightDraft = sent;
  emit("send", text);
  if (props.sendOutcome) {
    // Textbook semantics: after a send the text no longer carries a mention, so
    // the derived state must reset or the next draft would inherit suppression.
    let outcome: GroupSendOutcome;
    try { outcome = await props.sendOutcome(); }
    finally { sendBusy.value = false; }
    if (inFlightDraft === sent) inFlightDraft = null;
    // Only `accepted` and `uncertain` own this draft: their prompt is durably
    // represented (transcript, or replayable via Retry), so the text can go.
    // `orphaned` must NOT touch the composer: the Topic watcher already dropped
    // this draft when the user switched Topics.
    // `rejected` keeps the same draft: no durable accept exists.
    // Only while still on the Group + Topic it was sent from.
    if ((outcome === "accepted" || outcome === "uncertain") && draftKey.value === sent.key) {
      if (loadDraft(sent.key) === sent.text) saveDraft(sent.key, "");
      if (promptText.value === sent.text) clearSentDraft();
    }
    return;
  }
  inFlightDraft = null;
  sendBusy.value = false;
  clearSentDraft();
}

async function handleCancel(): Promise<void> {
  await runAction("stop");
}

async function runAction(action: "stop" | "restore" | "takeover"): Promise<void> {
  const run = groupsStore.activeRun;
  const instanceId = groupsStore.instanceId;
  if (!run || !instanceId || actionBusy.value || groupsStore.cancellingRunId) return;
  const key = draftKey.value;
  const groupId = groupsStore.selectedGroupId;
  const text = promptText.value;
  const revision = draftRevision.value;
  if (action === "takeover" && !text.trim()) return;
  actionBusy.value = true;
  actionError.value = null;
  try {
    const recovered = action === "restore" ? await sourceRunPrompt(instanceId, run, groupsStore.messages) : null;
    if (key !== draftKey.value) return;
    if (action === "restore" && recovered === null) { actionError.value = t("collaboration.promptUnavailable"); return; }
    const outcome = await groupsStore.cancelCurrentRun({ runId: run.id });
    if (key !== draftKey.value || outcome.scope?.instanceId !== instanceId
      || outcome.scope.conversationId !== run.conversationId || outcome.scope.topicId !== run.topicId
      || outcome.scope.groupId !== groupId || outcome.runId !== run.id) return;
    if (outcome.status !== "cancelled" && outcome.status !== "terminal") { actionError.value = t("collaboration.stopUnconfirmed"); return; }
    if (action === "restore" && recovered !== null) {
      promptText.value = mergeRecoveredDraft(promptText.value, recovered);
      restoreNotice.value = t("collaboration.restored");
      await nextTick();
      composer.value?.focus();
    } else if (action === "takeover") {
      if (promptText.value !== text || draftRevision.value !== revision) return;
      await handleSend();
    }
  } catch { actionError.value = t("collaboration.stopUnconfirmed"); }
  finally { actionBusy.value = false; }
}

function confirmUnresolved(): void {
  const pending = unresolvedConfirm.value;
  unresolvedConfirm.value = null;
  if (!pending || pending.key !== draftKey.value || pending.text !== promptText.value
    || pending.target !== JSON.stringify(selection.value)) return;
  void handleSend(undefined, true);
}

watch(() => JSON.stringify(everyoneRecipients.value), () => {
  if (everyoneConfirm.value) everyoneConfirm.value = {
    key: draftKey.value, text: promptText.value, revision: draftRevision.value,
    recipientIds: everyoneRecipients.value.map(member => member.id), unresolvedConfirmed: everyoneConfirm.value.unresolvedConfirmed,
  };
});
watch(() => JSON.stringify(selection.value), () => {
  if (!isEveryone.value) everyoneConfirm.value = null;
  unresolvedConfirm.value = null;
});

/** Replay the frozen prompt tuple (requestId + text + target). Never re-derives
 *  from the current UI selection: the server keyed the durable accept on the
 *  original requestId, so a retry must resend exactly what may already be
 *  committed — switching members here would desync UI and execution. */
function handleRetry(): void {
  void groupsStore.retryUncertainPrompt();
}
</script>

<template>
  <div class="shrink-0 bg-gradient-to-t from-bg to-transparent px-2.5 lg:px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-1.5">
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

    <p v-if="actionError" role="alert" class="mb-2 text-xs text-danger">{{ actionError }}</p>
    <p v-if="restoreNotice" role="status" class="mb-2 text-xs text-fg-muted">{{ restoreNotice }}</p>
    <div v-if="groupsStore.isRunActive" class="mb-2 flex items-center gap-2 text-xs">
      <button type="button" class="min-h-11 rounded-lg px-2 text-danger hover:bg-raised disabled:opacity-50" :disabled="actionBusy || !!groupsStore.cancellingRunId" @click="runAction('stop')">{{ $t('group.detail.stopRun') }}</button>
      <button type="button" class="min-h-11 rounded-lg px-2 hover:bg-raised disabled:opacity-50" :disabled="actionBusy || !!groupsStore.cancellingRunId" @click="runAction('restore')">{{ $t('collaboration.stopRestore') }}</button>
      <button type="button" class="min-h-11 rounded-lg px-2 text-accent hover:bg-raised disabled:opacity-50" :title="$t('collaboration.takeoverHint')" :disabled="actionBusy || !!groupsStore.cancellingRunId || !promptText.trim()" @click="runAction('takeover')">{{ $t('collaboration.takeover') }}</button>
    </div>
    <ComposerConfirmDialog v-if="everyoneConfirm" :title="$t('group.confirmEveryone.title', { count: everyoneRecipients.length })" :confirm-label="$t('group.confirmEveryone.send')" :pending="sendBusy" @cancel="everyoneConfirm = null" @confirm="handleSend(everyoneConfirm ?? undefined)">
      <ul class="space-y-1">
        <li v-for="recipient in everyoneRecipients.slice(0, 5)" :key="recipient.id">{{ recipient.name }} <span v-if="recipient.lead" class="text-xs text-fg-muted">{{ $t('group.target.lead') }}</span></li>
      </ul>
      <p v-if="everyoneRecipients.length > 5" class="mt-2 text-xs text-fg-muted">{{ $t('group.confirmEveryone.remaining', { count: everyoneRecipients.length - 5 }) }}</p>
      <p v-if="everyoneRecipients.find(member => member.lead)" class="mt-2 text-xs text-fg-muted">{{ $t('group.target.lead') }}: {{ everyoneRecipients.find(member => member.lead)?.name }}</p>
    </ComposerConfirmDialog>
    <ComposerConfirmDialog v-if="unresolvedConfirm" :title="$t('group.mentionConfirm.title')" :confirm-label="$t('group.confirmEveryone.send')" @cancel="unresolvedConfirm = null" @confirm="confirmUnresolved">
      <p>{{ $t('group.mentionConfirm.body') }}</p>
      <p class="mt-2 text-xs text-fg-muted">{{ selectionLabel }}</p>
    </ComposerConfirmDialog>
    <div v-if="!needsFirstTopic" class="mb-2 flex items-center gap-2">
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
                    :aria-disabled="!!memberUnavailableReason(b)"
                    :title="memberUnavailableReason(b) ?? undefined"
                    class="flex w-full items-center gap-2 rounded-sm px-2 text-left text-sm"
                    :class="[mobile ? 'h-11' : 'h-8', !b.enabled ? 'cursor-not-allowed text-fg-muted/50' : 'text-fg']"
                    @click="toggleMember(b.id)">
              <BotAvatar :avatar="b.avatar" :driver="driverFor(b)" :name="b.name" :size="24" static
                         :disabled="!b.enabled" :retired="b.retired" :class="!b.enabled ? 'opacity-50' : ''" />
              <span class="min-w-0 flex-1 truncate" :class="!b.enabled ? 'text-fg-muted' : 'text-fg'">{{ b.name }}</span>
              <span v-if="memberUnavailableReason(b)" class="shrink-0 text-xs text-fg-muted">{{ memberUnavailableReason(b) }}</span>
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
      :disabled="disabled || groupsStore.promptInFlight || !groupsStore.topicReady"
      :sending="groupsStore.promptInFlight"
      :cancelling="actionBusy || !!groupsStore.cancellingRunId"
      :send-disabled="!canSend"
      :placeholder="needsFirstTopic ? $t('group.prompt.createTopicFirst') : $t('group.prompt.placeholder')"
      textarea-test-id="group-composer-textarea"
      send-test-id="group-send-prompt-button"
      stop-test-id="group-stop-run-button"
      @send="handleSend()"
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
            :aria-disabled="!member.enabled"
            :title="!member.enabled ? memberUnavailableReason(props.bots.find(bot => bot.id === member.botId)!) ?? undefined : undefined"
            class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm"
            :class="index === mentionActiveIdx ? 'bg-surface-2' : 'hover:bg-surface-2'"
            @pointerdown.prevent
            @click="pickMention(member)"
          >
            <span class="min-w-0 flex-1 truncate font-medium text-fg">@{{ member.name }}</span>
            <span v-if="member.lead" class="shrink-0 text-xs text-accent">{{ $t("group.target.lead") }}</span>
            <span v-if="member.role" class="shrink-0 truncate text-xs text-fg-muted">{{ member.role }}</span>
            <span v-if="!member.enabled" class="shrink-0 text-xs text-fg-muted">{{ memberUnavailableReason(props.bots.find(bot => bot.id === member.botId)!) }}</span>
            <span class="shrink-0 font-mono text-xs text-fg-muted">{{ member.botId }}</span>
          </button>
        </div>
      </template>
    </ConversationComposer>
  </div>
</template>
