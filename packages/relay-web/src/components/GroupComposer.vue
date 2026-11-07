<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AtSign, MessagesSquare } from "lucide-vue-next";
import type { BotSummaryDto, ConversationTargetDto, PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
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
import { useComposerStore } from "../stores/composer";
import { supportsRoundtableV1, useInstancesStore } from "../stores/instances";
import { useGroupsStore, type GroupSendOutcome } from "../stores/groups";
import ConversationComposer from "./ConversationComposer.vue";
import ComposerAttachments from "./ComposerAttachments.vue";
import ComposerAttachPicker from "./ComposerAttachPicker.vue";
import { groupDraftKey, loadDraft, saveDraft } from "../lib/composer-drafts";
import ComposerConfirmDialog from "./ComposerConfirmDialog.vue";
import MobileSheet from "./MobileSheet.vue";
import { useIsMobile } from "../lib/use-dropdown";
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
  /** The status bar above the composer owns Stop all. An old daemon keeps the
   *  legacy transcript (and no status bar), so it keeps the in-card Stop. */
  hideStop?: boolean;
}>();

const emit = defineEmits<{
  /** `target` is null for the implicit lead: the server resolves it. */
  send: [text: string, media: PromptAttachmentRef[], target: ConversationTargetDto | null];
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
/** Cancel fences on the store's cancellingRunId: a second click while the
 *  store reports the run as cancelling is a no-op, never a second RPC. */
interface EveryoneConfirmation {
  key: string;
  revision: number;
  recipientIds: string[];
  text: string;
}
const everyoneConfirm = ref<EveryoneConfirmation | null>(null);
/** Revision of the draft text, bumped on every user edit. The everyone dialog
 *  snapshots it so a typed change invalidates the frozen recipient list. */
const draftRevision = ref(0);
const composer = ref<InstanceType<typeof ConversationComposer> | null>(null);
const composing = ref(false);
const collapsedCaret = ref(true);
const cmdActiveIdx = ref(0);
const cmdDismissed = ref(false);
const mentionActiveIdx = ref(0);
const mentionDismissed = ref(false);
const mentionBindings = ref<MentionBinding[]>([]);
const mentionOwned = ref(false);
/** The token the last boundary commit could not resolve, for the blocking
 *  dialog. Cleared whenever the draft stops carrying an unresolvable token. */
const lastUnresolvedToken = ref<string | null>(null);
/** Blocking surface for an unresolvable mention: names the token, sends
 *  nothing, keeps the draft. */
const unresolvedConfirm = ref<{ key: string; text: string; target: string; token: string; reason: string } | null>(null);
const sendBusy = ref(false);
const attachments = useComposerStore();
/** Below lg the completion selector is a bottom sheet, not a popover. */
const isMobile = useIsMobile();
/** Below Tailwind `sm` (640px) the full placeholder no longer fits one line. */
const isNarrow = ref(typeof window !== "undefined" && window.innerWidth < 640);
function syncNarrow(): void { isNarrow.value = window.innerWidth < 640; }
onMounted(() => window.addEventListener("resize", syncNarrow));
onBeforeUnmount(() => window.removeEventListener("resize", syncNarrow));
/** Attachment scope: one upload draft per instance + Group + Topic, namespaced
 *  "group" so it never collides with the session chat or direct Bot scopes. */
const attachKey = computed(() =>
  JSON.stringify(["group", props.instanceId ?? groupsStore.instanceId, groupsStore.activeConversationId, groupsStore.activeTopicId]),
);
watch(attachKey, () => {
  const id = props.instanceId ?? groupsStore.instanceId;
  if (id) attachments.bindInstance(id, attachKey.value);
}, { immediate: true });
const readyMedia = computed(() => attachments.pending.some((entry) => entry.status === "ready"));

/** The stored structured selection. The picker is gone; this now only carries
 *  what the mention machinery resolved (`@Name`, `@everyone`). A plain message
 *  ignores it entirely and lets the server resolve the Group lead. */
const selection = computed(() => groupsStore.targetSelection);
const isEveryone = computed(() => selection.value?.mode === "everyone");

const roundtableSupported = computed(() => {
  const id = props.instanceId ?? groupsStore.instanceId;
  return id ? supportsRoundtableV1(instancesStore.byId(id)) : false;
});

/** Enabled members in the Group's own membership order: the discussion
 *  speaker pool when no `@` selection narrows it. */
const enabledMemberIds = computed<string[]>(() => {
  const group = groupsStore.currentGroup;
  if (!group) return [];
  const byId = new Map(props.bots.filter((bot) => bot.retired !== true).map((bot) => [bot.id, bot] as const));
  return group.botIds.filter((id) => byId.get(id)?.enabled === true);
});

/** The lead's display name for the placeholder. An unknown catalog row keeps
 *  the neutral copy rather than inventing a name. */
const leadName = computed(() => {
  const leadId = groupsStore.currentGroup?.leadBotId;
  return props.bots.find((bot) => bot.id === leadId)?.name;
});

const composerPlaceholder = computed(() => {
  if (props.needsFirstTopic) return t("group.prompt.createTopicFirst");
  if (isNarrow.value) return t("group.prompt.placeholderShort");
  return leadName.value
    ? t("conversation.composer.placeholder", { name: leadName.value })
    : t("conversation.composer.placeholderLead");
});

/** 讨论 speakers: the `@` selection when it names at least two members, else
 *  every enabled member. The lead goes first, as the design requires the UI to
 *  open the discussion. */
const discussionSpeakers = computed<string[]>(() => {
  const selected = mentionBindings.value.length >= 2
    ? mentionBindings.value.map((binding) => binding.botId)
    : enabledMemberIds.value;
  const leadId = groupsStore.currentGroup?.leadBotId;
  return [...new Set(selected)].sort((left, right) =>
    left === leadId ? -1 : right === leadId ? 1 : 0);
});
const discussionReady = computed(() => roundtableSupported.value && discussionSpeakers.value.length >= 2);

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
  // The target belongs to ONE message: a sent `@everyone` or `@member` selection
  // must not linger and silently route the next plain message. Reset to the
  // Group default (the lead), which the send path only uses as a fallback.
  const group = groupsStore.currentGroup;
  if (group) groupsStore.setTarget(groupsStore.defaultTargetFor(group));
  closeMenu();
}

// Every edit is persisted under the current Group + Topic, so a draft survives
// switching away (and a tab reload). Sync, so an edit is always filed under the
// key it was typed against.
watch(promptText, (text) => {
  if (swappingDraft) return;
  saveDraft(draftKey.value, text);
  draftRevision.value += 1;
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
  const byId = new Map(props.bots.filter((b) => b.retired !== true).map((b) => [b.id, b] as const));
  return group.botIds
    .filter((id) => byId.get(id)?.enabled === true)
    .map((id) => ({ id, name: byId.get(id)?.name ?? id, lead: group.leadBotId === id }));
});

/** A Bot's default workspace is runnable when the instance lists it, or when
 *  it is the Bot's own daemon-allocated workspace: that directory is
 *  deliberately absent from every workspace picker, yet its owner runs there. */
function botWorkspaceRunnable(
  instance: { workspaces: Array<{ name: string }> },
  bot: BotSummaryDto,
): boolean {
  if (instance.workspaces.some((workspace) => workspace.name === bot.workspace)) return true;
  return bot.dedicatedWorkspace?.name === bot.workspace;
}

function memberUnavailableReason(bot: BotSummaryDto): string | null {
  if (bot.retired) return t("bot.status.disabled");
  const instance = instancesStore.byId(props.instanceId ?? groupsStore.instanceId ?? "");
  if (instance && (!instance.agents.some(agent => agent.name === bot.agent)
    || !botWorkspaceRunnable(instance, bot))) return t("group.target.noRuntime");
  return bot.enabled ? null : t("bot.status.disabled");
}

/** Close every transient completion surface (Escape, send, draft swap). */
function closeMenu(): void {
  mentionDismissed.value = true;
  cmdDismissed.value = true;
}

/** The `@` chip inserts the mention trigger at the caret and opens the same
 *  mention menu typing `@` opens. */
function startMention(): void {
  if (props.disabled || groupsStore.hasUncertainPrompt) return;
  const at = Math.min(caret.value, promptText.value.length);
  promptText.value = `${promptText.value.slice(0, at)}@${promptText.value.slice(at)}`;
  mentionDismissed.value = false;
  cmdDismissed.value = true;
  caret.value = at + 1;
  void nextTick(() => {
    composer.value?.focus();
    composer.value?.setSelectionRange(at + 1, at + 1);
  });
}

const mentionMembers = computed<GroupMentionMember[]>(() => {
  const leadId = groupsStore.currentGroup?.leadBotId;
  return props.bots
    .filter((bot) => bot.retired !== true)
    .map((bot) => ({
      botId: bot.id,
      name: bot.name,
      ...(bot.role ? { role: bot.role } : {}),
      enabled: memberUnavailableReason(bot) === null,
      lead: bot.id === leadId,
    }));
});

const singleMemberId = computed(() => (mentionBindings.value.length === 1
  ? mentionBindings.value[0]!.botId
  : null));

function commandsFor(botId: string) {
  const instanceId = props.instanceId ?? groupsStore.instanceId;
  const conversationId = groupsStore.activeConversationId;
  const topicId = groupsStore.activeTopicId;
  if (!instanceId || !conversationId || !topicId) return [];
  return commandStore.commandsFor({ instanceId, conversationId, topicId, botId });
}

/** A slash command may follow leading mentions: `@Tester /compact`. The
 *  mention selects the Bot whose commands are offered; without a mention the
 *  Group's lead is the implicit target (the same rule a plain message uses). */
const LEADING_MENTIONS = /^(?:@(?:"[^"]*"|[^\s@,;:!?.，。：；！？]+)\s+)+/;

const slashPrefixLength = computed(() => LEADING_MENTIONS.exec(promptText.value)?.[0].length ?? 0);

const slash = computed(() => {
  const text = promptText.value;
  const prefix = slashPrefixLength.value;
  const query = slashQuery(text.slice(prefix));
  if (!query) return null;
  return {
    query: query.query,
    range: {
      start: query.range.start + prefix,
      end: query.range.end + prefix,
    },
  };
});

/** The Bot whose command catalog backs completion and the send. One mentioned
 *  member wins; otherwise the lead is the Group's default target. */
const slashTargetBotId = computed(() => singleMemberId.value ?? groupsStore.currentGroup?.leadBotId ?? null);

const slashMatches = computed(() => {
  const query = slash.value;
  const botId = slashTargetBotId.value;
  if (!query || !botId || cmdDismissed.value) return [];
  return commandsFor(botId).filter((command) => command.name.toLowerCase().startsWith(query.query)).slice(0, 8);
});
/** The command menu cannot offer rows without a target Bot (a Group with no
 *  lead and no selected member). The hint explains why, exactly as before. */
const slashHint = computed(() => Boolean(slash.value) && !slashTargetBotId.value && !cmdDismissed.value);
const caret = ref(0);
const mentionQuery = computed(() => groupMentionQuery(promptText.value, caret.value));
const mentionMatches = computed(() => {
  const query = mentionQuery.value;
  if (!query || mentionDismissed.value) return [];
  return filterMentionMembers(mentionMembers.value, query.query).slice(0, 8);
});
/** The completion menu (slash hint, slash rows or mention rows) is showing. */
const cmdMenuOpen = computed(() => slashHint.value || slashMatches.value.length > 0 || mentionMatches.value.length > 0);

watch([singleMemberId, () => groupsStore.currentGroup?.leadBotId], () => {
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
    lastUnresolvedToken.value = applied.displayToken;
    return false;
  }
  lastUnresolvedToken.value = null;
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
/** The sheet is part of the composer's own layer: a tap on its chrome (scrim,
 *  grabber, ✕) blurs the textarea on some platforms, which is not the user
 *  leaving the composer — the half-typed mention must survive it. */
function onComposerBlur(): boolean {
  if (isMobile.value && cmdMenuOpen.value) return true;
  return commitMentionAtBoundary();
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
/** The bottom sheet closed (scrim, ✕, back gesture): dismiss the menu the way
 *  Escape does — the half-typed mention stays — and hand focus back to the
 *  textarea. */
function closeCmdMenu(): void {
  mentionDismissed.value = true;
  cmdDismissed.value = true;
  void nextTick(() => composer.value?.focus());
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
 *  committed before the target is derived — a mention is what selects members
 *  for this very send. */
const baseCanSend = computed(() => !props.disabled
  && !groupsStore.promptInFlight
  && !groupsStore.cancellingRunId
  && groupsStore.topicReady
  // A Run already executing does not block sending: the backend queues the
  // prompt behind the standing owner. Only an unknown prompt outcome does,
  // because its frozen tuple is the sole safe way forward.
  && !groupsStore.hasUncertainPrompt);

/** Final send guard: evaluated after any pending mention has been committed.
 *  Staged attachments make an empty text sendable. There is no target guard:
 *  a plain message is the implicit lead, which the server resolves. */
const canSend = computed(() => baseCanSend.value
  && !sendBusy.value
  && (promptText.value.trim().length > 0 || readyMedia.value));

/** 讨论 is a send variant, so it needs the same draft and the speaker floor. */
const canDiscuss = computed(() => canSend.value && discussionReady.value);

/** True when the draft carries a slash command after any leading mentions.
 *  Commands are per-Bot, so such a send must never broadcast: it goes to the
 *  mentioned member, else the lead. */
function hasSlashCommand(text: string): boolean {
  const prefix = LEADING_MENTIONS.exec(text)?.[0] ?? "";
  const token = text.slice(prefix.length).trim().split(/\s+/, 1)[0] ?? "";
  return token.startsWith("/") && token.length > 1;
}

/** The structured target for this send.
 *
 *  - no mention: `null` — the backend resolves the Group's live lead inside its
 *    accept gates (design §8.3);
 *  - `@Name` mentions: exactly those members, in parallel;
 *  - `@everyone`: everyone, still parallel (never silently a roundtable);
 *  - 讨论: a one-round roundtable over the selected members or all enabled. */
function sendTarget(discuss: boolean): ConversationTargetDto | null {
  if (discuss) {
    return { mode: "roundtable", botIds: discussionSpeakers.value, rounds: 1 };
  }
  // A slash command is per-Bot: never broadcast it. It targets the mentioned
  // member, else the lead, exactly like the completion catalog above.
  if (hasSlashCommand(promptText.value)) {
    const botId = slashTargetBotId.value;
    return botId ? { mode: "members", botIds: [botId] } : null;
  }
  if (isEveryone.value) return { mode: "everyone" };
  const bindings = mentionBindings.value;
  if (bindings.length > 0) return { mode: "members", botIds: bindings.map((binding) => binding.botId) };
  return null;
}

async function handleSend(confirmedEveryone?: EveryoneConfirmation, discuss = false): Promise<void> {
  if (sendBusy.value || !baseCanSend.value) return;
  if (discuss && !discussionReady.value) return;
  if (confirmedEveryone && (confirmedEveryone.key !== draftKey.value
    || confirmedEveryone.text !== promptText.value || confirmedEveryone.revision !== draftRevision.value
    || !isEveryone.value)) { everyoneConfirm.value = null; return; }
  const text = promptText.value.trim();
  const staged = attachments.snapshot(attachKey.value);
  if (!text && staged.media.length === 0) return;
  if (attachments.uploading) return;
  // The token under the caret is now final, so the structured target must
  // reflect it before the target is derived. A token that resolves to nothing
  // blocks the send outright: falling back to the implicit lead would
  // silently route an @-targeted message to a member the user never named.
  // The draft is kept and no prompt is emitted; fixing or removing the token
  // re-arms the send. `applyMention` already surfaced the reason as
  // `mentionUnresolved` / `mentionAmbiguous` / `mentionDisabled` /
  // `mentionRemoved`.
  const resolved = commitMentionAtBoundary();
  if (!resolved) {
    const reason = groupsStore.promptError?.startsWith("mention") ? groupsStore.promptError : "mentionUnresolved";
    unresolvedConfirm.value = {
      key: draftKey.value,
      text: promptText.value,
      target: JSON.stringify(selection.value),
      token: lastUnresolvedToken.value ?? "",
      reason,
    };
    return;
  }
  if (!discuss && isEveryone.value && !hasSlashCommand(text)) {
    const recipientIds = everyoneRecipients.value.map(member => member.id);
    if (!recipientIds.length) { groupsStore.promptError = "targetEmpty"; return; }
    const snapshot = { key: draftKey.value, revision: draftRevision.value, recipientIds, text: promptText.value };
    if (!confirmedEveryone || JSON.stringify(confirmedEveryone) !== JSON.stringify(snapshot)) {
      everyoneConfirm.value = snapshot;
      return;
    }
  }
  everyoneConfirm.value = null;
  unresolvedConfirm.value = null;
  const target = sendTarget(discuss);
  sendBusy.value = true;
  // The parent resolves the send against the store and reports the outcome, so
  // the draft decision uses the real result: an accepted prompt is in the
  // transcript, an uncertain one is replayable via Retry, but a definitive
  // refusal has neither and must leave the typed text in place.
  const sent = { key: draftKey.value, text: promptText.value };
  inFlightDraft = sent;
  emit("send", text, staged.media, target);
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
      // The media travelled with the prompt (transcript, or the frozen retry
      // tuple on uncertain), so the staged chips go with the text.
      attachments.consume(attachKey.value, staged.ids);
      if (loadDraft(sent.key) === sent.text) saveDraft(sent.key, "");
      if (promptText.value === sent.text) clearSentDraft();
    }
    return;
  }
  inFlightDraft = null;
  sendBusy.value = false;
  attachments.consume(attachKey.value, staged.ids);
  clearSentDraft();
}

/** 讨论: send the same draft as a one-round discussion. */
function handleDiscuss(): void {
  void handleSend(undefined, true);
}

/** The legacy in-card Stop forwards to the pane, which owns the Run-level
 *  `stopCurrentAndQueued` call (the status bar's Stop all uses the same path).
 *  The card already owns the cancel fences: it shows Stop only while a Run is
 *  active and disables it while a cancel is in flight. */
function handleCancel(): void {
  emit("cancel");
}

async function onPaste(e: ClipboardEvent): Promise<void> {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length === 0 || props.disabled || !groupsStore.topicReady || groupsStore.promptInFlight) return;
  e.preventDefault();
  await attachments.addFiles(files, attachKey.value);
}

async function onDrop(e: DragEvent): Promise<void> {
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length === 0 || props.disabled || !groupsStore.topicReady || groupsStore.promptInFlight) return;
  e.preventDefault();
  await attachments.addFiles(files, attachKey.value);
}

/** Dismiss the blocking unresolved-mention surface. The send stays blocked and
 *  the draft stays: only fixing or removing the token re-arms the send. */
function dismissUnresolved(): void {
  unresolvedConfirm.value = null;
}

watch(() => JSON.stringify(everyoneRecipients.value), () => {
  if (everyoneConfirm.value) everyoneConfirm.value = {
    key: draftKey.value, text: promptText.value, revision: draftRevision.value,
    recipientIds: everyoneRecipients.value.map(member => member.id),
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


    <ComposerConfirmDialog v-if="everyoneConfirm" :title="$t('group.confirmEveryone.title', { count: everyoneRecipients.length })" :confirm-label="$t('group.confirmEveryone.send')" :pending="sendBusy" @cancel="everyoneConfirm = null" @confirm="handleSend(everyoneConfirm ?? undefined)">
      <ul class="space-y-1">
        <li v-for="recipient in everyoneRecipients.slice(0, 5)" :key="recipient.id">{{ recipient.name }} <span v-if="recipient.lead" class="text-xs text-fg-muted">{{ $t('group.target.lead') }}</span></li>
      </ul>
      <p v-if="everyoneRecipients.length > 5" class="mt-2 text-xs text-fg-muted">{{ $t('group.confirmEveryone.remaining', { count: everyoneRecipients.length - 5 }) }}</p>
      <p v-if="everyoneRecipients.find(member => member.lead)" class="mt-2 text-xs text-fg-muted">{{ $t('group.target.lead') }}: {{ everyoneRecipients.find(member => member.lead)?.name }}</p>
    </ComposerConfirmDialog>
    <ComposerConfirmDialog v-if="unresolvedConfirm" :title="$t('group.mentionConfirm.title')" :confirm-label="$t('group.mentionConfirm.keepEditing')" @cancel="dismissUnresolved" @confirm="dismissUnresolved">
      <p>{{ $t('group.mentionConfirm.body') }}</p>
      <!-- Names the token that could not resolve (never the member roster):
           fixing or removing exactly this token re-arms the send. -->
      <p data-test="group-unresolved-token" class="mt-2 text-xs font-medium text-fg">{{ unresolvedConfirm.token }}</p>
      <p class="mt-2 text-xs text-fg-muted">{{ $t(`bot.errors.${unresolvedConfirm.reason}`) }}</p>
    </ComposerConfirmDialog>

    <ConversationComposer
      ref="composer"
      v-model="promptText"
      :busy="groupsStore.isRunActive"
      :disabled="disabled || groupsStore.promptInFlight || !groupsStore.topicReady"
      :sending="groupsStore.promptInFlight"
      :cancelling="!!groupsStore.cancellingRunId"
      :send-disabled="!canSend"
      :has-attachments="readyMedia"
      :attachments-send-disabled="attachments.uploading"
      :placeholder="composerPlaceholder"
      :hide-stop="hideStop"
      textarea-test-id="group-composer-textarea"
      send-test-id="group-send-prompt-button"
      stop-test-id="group-stop-run-button"
      @send="handleSend()"
      @cancel="handleCancel"
      @keydown="onKeydown"
      @input="onInput"
      @paste="onPaste"
      @drop="onDrop"
      @caret="onCaret"
      @compositionstart="composing = true"
      @compositionend="onCompositionEnd"
      @blur="onComposerBlur"
    >
      <!-- One-line chips: @ selects members for this send (parallel), 讨论 turns
           the same draft into a sequential one-round discussion. The chip is
           absent when the daemon does not advertise roundtable v1. -->
      <template #chips>
        <button
          type="button"
          data-test="group-mention-chip"
          :title="$t('conversation.composer.mention')"
          :aria-label="$t('conversation.composer.mention')"
          :disabled="disabled || groupsStore.hasUncertainPrompt"
          class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          @click="startMention"
        >
          <AtSign :size="13" aria-hidden="true" />
        </button>
        <button
          type="button"
          v-if="roundtableSupported"
          data-test="group-discuss-chip"
          :title="discussionReady ? $t('conversation.composer.discussHint') : $t('conversation.composer.discussNeedsSpeakers')"
          :aria-label="$t('conversation.composer.discuss')"
          :disabled="!canDiscuss"
          class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors"
          :class="canDiscuss ? 'text-accent-text hover:bg-accent/10' : 'cursor-not-allowed text-fg-muted/60'"
          @click="handleDiscuss"
        >
          <MessagesSquare :size="13" />
          <span>{{ $t("conversation.composer.discuss") }}</span>
        </button>
      </template>
      <template #attachments>
        <ComposerAttachments
          v-if="props.instanceId ?? groupsStore.instanceId"
          :scope-key="attachKey"
          :disabled="disabled || groupsStore.promptInFlight || !groupsStore.topicReady"
        />
      </template>
      <template #actions>
        <ComposerAttachPicker
          v-if="props.instanceId ?? groupsStore.instanceId"
          :scope-key="attachKey"
          :disabled="disabled || groupsStore.promptInFlight || !groupsStore.topicReady"
        />
      </template>
      <template #menus>
      <!-- Below lg the selector is a bottom sheet (rows are finger-sized); at lg
           the inline popovers above the composer stay exactly as they were. -->
      <Teleport
        v-if="isMobile && cmdMenuOpen"
        to="body"
      >
        <MobileSheet :title="$t('bot.prompt.completions')" test-id="group-cmd-sheet" @close="closeCmdMenu">
          <!-- The textarea keeps DOM focus while its list is open, so the sheet
               must not move focus on mount: this is the sheet's initial-focus
               target and is not focusable. -->
          <span data-sheet-initial-focus aria-hidden="true" />
          <div
            v-if="slashHint"
            data-test="group-slash-hint"
            class="w-full rounded-2xl bg-raised px-3 py-2 text-xs text-fg-muted"
          >
            {{ $t("bot.errors.slashSelectMember") }}
          </div>
          <div v-else-if="slashMatches.length > 0" data-test="group-cmd-menu" class="w-full">
            <button
              v-for="(command, index) in slashMatches"
              :key="command.name"
              type="button"
              data-test="group-cmd-item"
              class="flex min-h-[46px] w-full items-center gap-2 rounded-sm px-3 text-left text-sm"
              :class="index === cmdActiveIdx ? 'bg-surface-2' : 'hover:bg-surface-2'"
              @pointerdown.prevent
              @click="pickSlash(command.name)"
            >
              <span class="font-medium text-fg">/{{ command.name }}</span>
              <span v-if="command.description" class="truncate text-xs text-fg-muted">{{ command.description }}</span>
            </button>
          </div>
          <div v-if="mentionMatches.length > 0" data-test="group-mention-menu" class="w-full">
            <button
              v-for="(member, index) in mentionMatches"
              :key="member.botId"
              type="button"
              data-test="group-mention-item"
              :data-bot-id="member.botId"
              :aria-disabled="!member.enabled"
              :title="!member.enabled ? memberUnavailableReason(props.bots.find(bot => bot.id === member.botId)!) ?? undefined : undefined"
              class="flex min-h-[46px] w-full items-center gap-2 rounded-sm px-3 text-left text-sm"
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
        </MobileSheet>
      </Teleport>

      <!-- Desktop (>= lg): the inline popovers. -->
      <div
        v-if="!isMobile && slashHint"
        data-test="group-slash-hint"
        class="absolute bottom-full left-0 z-20 mb-2 w-full rounded-2xl bg-raised px-3 py-2 text-xs text-fg-muted shadow-float"
      >
        {{ $t("bot.errors.slashSelectMember") }}
      </div>
      <div
        v-else-if="!isMobile && slashMatches.length > 0"
        data-test="group-cmd-menu"
        class="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full overflow-y-auto rounded-lg bg-glass-strong p-1 shadow-glass-float backdrop-blur-glass backdrop-saturate-glass"
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
        v-if="!isMobile && mentionMatches.length > 0"
        data-test="group-mention-menu"
        class="absolute bottom-full left-0 z-20 mb-2 max-h-56 w-full overflow-y-auto rounded-lg bg-glass-strong p-1 shadow-glass-float backdrop-blur-glass backdrop-saturate-glass"
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
