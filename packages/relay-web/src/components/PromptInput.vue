<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  Brain,
  Check,
  ChevronDown,
  Gauge,
  Paperclip,
  Send,
  SlidersHorizontal,
  X,
} from "lucide-vue-next";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import { loadDraft, saveDraft } from "../lib/composer-drafts";
import { createDebouncedFlush } from "../lib/debounce-flush";
import { clampPanelWidth, createBottomPanelResize } from "../lib/resize-panel";
import UsagePopover from "./UsagePopover.vue";
import { useComposerStore } from "../stores/composer";
import { useSessionControlsStore } from "../stores/session-controls";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { formatModelLabel } from "../lib/model-label";
import { sessionPresentationName } from "../lib/sidebar-group-mode";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const props = defineProps<{
  busy?: boolean;
  draftKey?: string;
  instanceId?: string | null;
  sessionAlias?: string | null;
}>();
const emit = defineEmits<{
  send: [
    text: string,
    media: PromptAttachmentRef[],
    agentMentions?: Array<{ range: [number, number]; handle: string }>,
  ];
  cancel: [];
}>();

const composer = useComposerStore();
const controls = useSessionControlsStore();
const chat = useChatStore();
const instancesStore = useInstancesStore();

// Context-usage meter (ACP usage_update) for the current session. Null when the agent
// doesn't report it (e.g. codex) or the window is unknown — the chip then hides.
const context = computed(() => {
  const u = chat.sessionUsage;
  if (!u || u.size <= 0) return null;
  const pct = Math.min(100, Math.round((u.used / u.size) * 100));
  const tone = pct >= 90 ? "danger" : pct >= 75 ? "warn" : "accent";
  return {
    used: u.used,
    size: u.size,
    pct,
    tone,
    cost: u.cost,
    breakdown: u.breakdown,
  };
});

// Click the meter to open a popover with the cost & per-turn token breakdown.
const usageOpen = ref(false);
const usageAnchor = ref<{
  top: number;
  left: number;
  width: number;
  height: number;
} | null>(null);
function toggleUsage(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  usageAnchor.value = {
    top: r.top,
    left: r.left,
    width: r.width,
    height: r.height,
  };
  usageOpen.value = !usageOpen.value;
}

// Load the session's model for the composer chip whenever the session changes.
const modelMenuOpen = ref(false);
const effortMenuOpen = ref(false);
watch(
  () => [props.instanceId, props.sessionAlias] as const,
  ([id, alias]) => {
    void controls.loadModel(id ?? null, alias ?? null);
    void controls.loadEffort(id ?? null, alias ?? null);
    modelMenuOpen.value = false;
    effortMenuOpen.value = false;
  },
  { immediate: true },
);
async function pickModel(id: string) {
  modelMenuOpen.value = false;
  const instanceId = props.instanceId;
  const sessionAlias = props.sessionAlias;
  if (!instanceId || !sessionAlias) return;
  await controls.setModel(instanceId, sessionAlias, id);
  if (props.instanceId === instanceId && props.sessionAlias === sessionAlias) {
    await controls.loadEffort(instanceId, sessionAlias);
  }
}
async function pickEffort(effort: string) {
  effortMenuOpen.value = false;
  if (props.instanceId && props.sessionAlias) {
    await controls.setEffort(props.instanceId, props.sessionAlias, effort);
  }
}
function toggleModelMenu() {
  effortMenuOpen.value = false;
  modelMenuOpen.value = !modelMenuOpen.value;
}
function toggleEffortMenu() {
  modelMenuOpen.value = false;
  effortMenuOpen.value = !effortMenuOpen.value;
}
const text = ref(loadDraft(props.draftKey ?? ""));
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

// Desktop-only: drag the strip above the composer to resize the textarea height.
// Mobile keeps the fixed rows="2" textarea, so `isDesktop` gates both the handle
// and the inline height (an inline height would otherwise override rows on mobile).
const HEIGHT_MIN = 60;
const HEIGHT_MAX = 480;
const HEIGHT_DEFAULT = 120;
const HEIGHT_VIEWPORT_FRACTION = 0.5;
// `matchMedia` is absent in some test/embedded runtimes; treat its absence as
// "not desktop" so the resize handle and inline height simply don't engage.
function queryDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(min-width: 1024px)").matches
  );
}
const isDesktop = ref(queryDesktop());
const composerHeight = ref(
  clampPanelWidth(
    Number(localStorage.getItem("xacpx.composerHeight")) || HEIGHT_DEFAULT,
    HEIGHT_MIN,
    HEIGHT_MAX,
    typeof window !== "undefined" ? window.innerHeight : undefined,
    HEIGHT_VIEWPORT_FRACTION,
  ),
);
const heightDragging = ref(false);
watch(composerHeight, (v) =>
  localStorage.setItem("xacpx.composerHeight", String(v)),
);

const heightResize = createBottomPanelResize({
  getHeight: () => composerHeight.value,
  setHeight: (h) => {
    composerHeight.value = h;
  },
  min: HEIGHT_MIN,
  max: HEIGHT_MAX,
  maxViewportFraction: HEIGHT_VIEWPORT_FRACTION,
  isEnabled: () => isDesktop.value,
  // Lock the cursor + suppress text selection for the whole document while
  // dragging, so a fast drag that outruns the thin handle still feels solid.
  onDragStart: () => {
    heightDragging.value = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  },
  onDragEnd: () => {
    heightDragging.value = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  },
});

let desktopMql: MediaQueryList | null = null;
function onDesktopChange(e: MediaQueryListEvent | MediaQueryList) {
  isDesktop.value = e.matches;
}

// Agent slash-command autocomplete: when the composer holds a single `/`-token, offer the
// session's advertised commands. Selecting one inserts `/name `; it then sends as a normal
// prompt (the agent interprets it). No commands / no match → no menu, composer unchanged.
const cmdMenuOpen = ref(false);
const cmdActiveIdx = ref(0);
const cmdQuery = computed(() => {
  const v = text.value;
  if (!v.startsWith("/") || v.includes("\n") || v.slice(1).includes(" "))
    return null;
  return v.slice(1).toLowerCase();
});
const cmdMatches = computed(() => {
  const q = cmdQuery.value;
  if (q === null) return [];
  return chat.sessionCommands
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .slice(0, 8);
});
watch(cmdMatches, (m) => {
  cmdMenuOpen.value = m.length > 0;
  cmdActiveIdx.value = 0;
});
function pickCommand(name: string) {
  text.value = `/${name} `;
  cmdMenuOpen.value = false;
  void nextTick(() => textarea.value?.focus());
}

interface AgentMentionItem {
  handle: string;
  displayName: string;
  sessionAlias?: string;
  hasCustomDisplayName: boolean;
  agent: string;
  workspace?: string;
  groupMode?: "instance" | "workspace" | "agent";
  nodeLabel?: string;
  instanceId?: string;
  nodeId: string;
  endpointId: string;
  activity?: {
    status: "idle" | "working" | "waiting";
    summary?: string;
  };
}

const availableAgents = computed<AgentMentionItem[]>(() => {
  return instancesStore.agentDirectory.map((ep) => {
    const inst = ep.instanceId
      ? instancesStore.instances.find((i) => i.id === ep.instanceId)
      : undefined;
    const nodeLabel = inst?.name;
    const groupMode = ep.instanceId
      ? instancesStore.groupModeFor(ep.instanceId)
      : undefined;
    const baseAlias = ep.sessionAlias || ep.agent;
    const primaryName = sessionPresentationName({
      displayName: ep.displayName,
      alias: baseAlias,
      workspace: ep.workspace,
      agent: ep.agent,
      groupMode,
    });
    const hasCustomDisplayName = Boolean(
      ep.displayName &&
        ep.sessionAlias &&
        ep.displayName !== ep.sessionAlias,
    );
    return {
      handle: `agent:${ep.nodeId}:${ep.endpointId}`,
      displayName: primaryName,
      sessionAlias: ep.sessionAlias,
      hasCustomDisplayName,
      agent: ep.agent,
      workspace: ep.workspace,
      groupMode,
      nodeLabel,
      instanceId: ep.instanceId,
      nodeId: ep.nodeId,
      endpointId: ep.endpointId,
      activity: ep.activity,
    };
  });
});

function formatSecondaryLine(
  item: AgentMentionItem,
  allItems: AgentMentionItem[],
): string {
  const parts: string[] = [];

  if (item.hasCustomDisplayName && item.sessionAlias) {
    const displayAlias = sessionPresentationName({
      alias: item.sessionAlias,
      workspace: item.workspace,
      agent: item.agent,
      groupMode: item.groupMode,
    });
    if (displayAlias && displayAlias !== item.displayName) {
      parts.push(displayAlias);
    }
  }

  if (item.workspace) {
    parts.push(item.workspace);
  }
  if (item.agent && item.agent !== item.displayName) {
    parts.push(item.agent);
  }

  const duplicates = allItems.filter(
    (other) =>
      other.displayName === item.displayName &&
      other.handle !== item.handle,
  );

  if (duplicates.length > 0) {
    const myBaseKey = [
      item.hasCustomDisplayName ? item.sessionAlias ?? "" : "",
      item.workspace ?? "",
      item.agent ?? "",
    ].join("::");
    const sameBaseDuplicates = duplicates.filter(
      (d) =>
        [
          d.hasCustomDisplayName ? d.sessionAlias ?? "" : "",
          d.workspace ?? "",
          d.agent ?? "",
        ].join("::") === myBaseKey,
    );

    if (sameBaseDuplicates.length > 0) {
      if (item.nodeLabel) {
        parts.push(item.nodeLabel);
      } else {
        const suffix =
          item.nodeId.length > 5 ? `…${item.nodeId.slice(-5)}` : item.nodeId;
        parts.push(suffix);
      }
    }
  }

  return parts.join(" · ");
}

function activityLabel(activity?: {
  status: "idle" | "working" | "waiting";
  summary?: string;
}): string {
  if (!activity?.status) return "";
  switch (activity.status) {
    case "working":
      return t("chat.mentionActivity.working");
    case "waiting":
      return t("chat.mentionActivity.waiting");
    case "idle":
      return t("chat.mentionActivity.idle");
    default:
      return "";
  }
}
function activityClass(status?: "idle" | "working" | "waiting"): string {
  switch (status) {
    case "working":
      return "text-run-bright";
    case "waiting":
      return "text-warn";
    case "idle":
      return "text-fg-muted";
    default:
      return "text-fg-muted";
  }
}

const mentionMenuOpen = ref(false);
const mentionActiveIdx = ref(0);
const mentionQuery = ref<string | null>(null);
const mentionCursorPos = ref(0);
const mentionStartPos = ref(-1);
interface BoundMention {
  handle: string;
  displayName: string;
  start: number;
  end: number;
}
const recordedMentions = ref<BoundMention[]>([]);
function updateMentionState() {
  const el = textarea.value;
  if (!el) {
    mentionMenuOpen.value = false;
    return;
  }
  const pos = el.selectionStart ?? 0;
  mentionCursorPos.value = pos;
  const beforeCursor = text.value.slice(0, pos);
  const lastAtIdx = beforeCursor.lastIndexOf("@");
  if (lastAtIdx === -1) {
    mentionMenuOpen.value = false;
    mentionQuery.value = null;
    mentionStartPos.value = -1;
    return;
  }
  if (lastAtIdx > 0 && !/[\s(]/.test(beforeCursor[lastAtIdx - 1]!)) {
    mentionMenuOpen.value = false;
    mentionQuery.value = null;
    mentionStartPos.value = -1;
    return;
  }
  const query = beforeCursor.slice(lastAtIdx + 1);
  if (/[\s\n]/.test(query)) {
    mentionMenuOpen.value = false;
    mentionQuery.value = null;
    mentionStartPos.value = -1;
    return;
  }
  mentionStartPos.value = lastAtIdx;
  mentionQuery.value = query.toLowerCase();
}

function computeRank(item: AgentMentionItem, q: string): number {
  if (!q) return 0;
  const dn = item.displayName.toLowerCase();
  const sa = (item.sessionAlias ?? "").toLowerCase();
  const ws = (item.workspace ?? "").toLowerCase();
  const ag = item.agent.toLowerCase();

  if (dn === q) return 1;
  if (sa && sa === q) return 2;
  if (dn.startsWith(q)) return 3;
  if (sa && sa.startsWith(q)) return 4;
  if (dn.includes(q)) return 5;
  if (sa && sa.includes(q)) return 6;
  if (ws && ws.startsWith(q)) return 7;
  if (ws && ws.includes(q)) return 8;
  if (ag.startsWith(q)) return 9;
  if (ag.includes(q)) return 10;

  return -1;
}

const mentionMatches = computed(() => {
  if (mentionQuery.value === null) return [];
  const q = mentionQuery.value.trim().toLowerCase();
  const all = availableAgents.value;

  const scored: Array<{ item: AgentMentionItem; rank: number }> = [];
  for (const item of all) {
    const rank = computeRank(item, q);
    if (rank !== -1) {
      scored.push({ item, rank });
    }
  }

  scored.sort((a, b) => {
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    const dnCmp = a.item.displayName.localeCompare(b.item.displayName);
    if (dnCmp !== 0) return dnCmp;
    const saCmp = (a.item.sessionAlias ?? "").localeCompare(
      b.item.sessionAlias ?? "",
    );
    if (saCmp !== 0) return saCmp;
    return a.item.handle.localeCompare(b.item.handle);
  });

  return scored.map((s) => s.item).slice(0, 8);
});

watch(mentionMatches, (m) => {
  mentionMenuOpen.value = m.length > 0 && mentionQuery.value !== null;
  mentionActiveIdx.value = 0;
});

function pickMention(agentItem: AgentMentionItem) {
  if (mentionStartPos.value < 0) return;
  const before = text.value.slice(0, mentionStartPos.value);
  const after = text.value.slice(mentionCursorPos.value);
  const targetToken = `@${agentItem.displayName}`;
  const insertion = `${targetToken} `;
  const start = mentionStartPos.value;
  const end = start + targetToken.length;
  text.value = before + insertion + after;
  recordedMentions.value.push({
    handle: agentItem.handle,
    displayName: agentItem.displayName,
    start,
    end,
  });
  mentionMenuOpen.value = false;
  mentionQuery.value = null;
  mentionStartPos.value = -1;
  void nextTick(() => {
    if (textarea.value) {
      textarea.value.focus();
      const newPos = before.length + insertion.length;
      textarea.value.setSelectionRange(newPos, newPos);
    }
  });
}

function openPicker() {
  fileInput.value?.click();
}
async function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) await composer.addFiles(Array.from(input.files));
  input.value = "";
}
async function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length > 0) {
    e.preventDefault();
    await composer.addFiles(files);
  }
}
async function onDrop(e: DragEvent) {
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length > 0) {
    e.preventDefault();
    await composer.addFiles(files);
  }
}

// Persist the draft per session and restore on switch: when the key changes, stash the
// current text under the previous key, then load the incoming session's draft.
// Writes are debounced (parse+stringify of the whole draft map per keystroke is a hot
// path), with a synchronous flush on pagehide/unmount so a reload right after typing
// still restores the very last input. The key+text are captured at schedule time so a
// late-firing write can never land under the wrong session.
let pendingDraft: { key: string; text: string } | null = null;
const draftPersist = createDebouncedFlush(() => {
  const p = pendingDraft;
  pendingDraft = null;
  if (p) saveDraft(p.key, p.text);
}, 300);
watch(text, (t) => {
  pendingDraft = { key: props.draftKey ?? "", text: t };
  draftPersist.schedule();
});
watch(
  () => props.draftKey,
  (next, prev) => {
    // The old session's text is stashed synchronously below — drop the pending write.
    pendingDraft = null;
    draftPersist.cancel();
    if (prev) saveDraft(prev, text.value);
    text.value = loadDraft(next ?? "");
  },
);
function flushDraft(): void {
  draftPersist.flush();
}
onMounted(() => {
  window.addEventListener("pagehide", flushDraft);
  if (typeof window.matchMedia === "function") {
    desktopMql = window.matchMedia("(min-width: 1024px)");
    isDesktop.value = desktopMql.matches;
    desktopMql.addEventListener("change", onDesktopChange);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("pagehide", flushDraft);
  desktopMql?.removeEventListener("change", onDesktopChange);
  flushDraft();
});

// External insert requests (e.g. command palette) targeted at this session.
watch(
  () => composer.insertRequest,
  (req) => {
    if (!req || req.key !== (props.draftKey ?? "")) return;
    text.value = text.value.trim()
      ? `${text.value.trimEnd()} ${req.text}`
      : req.text;
    void nextTick(() => textarea.value?.focus());
  },
);

// Sent-message history (↑/↓ recall, à la a shell prompt).
const history = ref<string[]>([]);
let historyIdx = -1; // -1 = editing a fresh line

function submit() {
  if (composer.uploading) return;
  const value = text.value.trim();
  const ready = composer.pending.filter((p) => p.status === "ready");
  if (!value && ready.length === 0) return;
  const media: PromptAttachmentRef[] = ready.map((p) => ({
    id: p.id,
    filePath: p.filePath as string,
    fileName: p.filename,
    mimeType: p.mimeType,
    kind: p.kind,
    size: p.size,
    ...(p.previewUrl ? { previewUrl: p.previewUrl } : {}),
  }));

  const rawText = text.value;
  const mentions: Array<{ range: [number, number]; handle: string }> = [];
  const seenRanges = new Set<string>();

  for (const item of recordedMentions.value) {
    const targetToken = `@${item.displayName}`;
    if (
      rawText.slice(item.start, item.start + targetToken.length) === targetToken
    ) {
      const key = `${item.start}:${item.handle}`;
      if (!seenRanges.has(key)) {
        seenRanges.add(key);
        mentions.push({
          range: [item.start, item.start + targetToken.length],
          handle: item.handle,
        });
      }
    }
  }

  mentions.sort((a, b) => a.range[0] - b.range[0]);

  if (mentions.length > 0) {
    emit("send", value, media, mentions);
  } else {
    emit("send", value, media);
  }
  composer.clearAttachments();
  recordedMentions.value = [];
  if (value && history.value[history.value.length - 1] !== value)
    history.value.push(value);
  historyIdx = -1;
  text.value = "";
  mentionMenuOpen.value = false;
  mentionQuery.value = null;
}

function recallHistory(dir: -1 | 1) {
  if (history.value.length === 0) return;
  if (dir === -1) {
    historyIdx =
      historyIdx === -1
        ? history.value.length - 1
        : Math.max(0, historyIdx - 1);
  } else {
    if (historyIdx === -1) return;
    historyIdx = historyIdx + 1;
    if (historyIdx >= history.value.length) {
      historyIdx = -1;
      text.value = "";
      return;
    }
  }
  text.value = history.value[historyIdx];
}

function onKeydown(e: KeyboardEvent) {
  // IME guard: never intercept keys mid-composition (CJK input) — Enter here confirms
  // the candidate, it must not submit. `isComposing` covers all input engines.
  if (e.isComposing) return;
  // Mention autocomplete takes keys while menu is open
  if (mentionMenuOpen.value && mentionMatches.value.length > 0) {
    if (e.key === "ArrowDown") {
      mentionActiveIdx.value =
        (mentionActiveIdx.value + 1) % mentionMatches.value.length;
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowUp") {
      mentionActiveIdx.value =
        (mentionActiveIdx.value - 1 + mentionMatches.value.length) %
        mentionMatches.value.length;
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const m = mentionMatches.value[mentionActiveIdx.value];
      if (m) pickMention(m);
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      mentionMenuOpen.value = false;
      e.preventDefault();
      return;
    }
  }
  // Command autocomplete takes the arrow/enter/tab/esc keys while its menu is open.
  if (cmdMenuOpen.value && cmdMatches.value.length > 0) {
    if (e.key === "ArrowDown") {
      cmdActiveIdx.value = (cmdActiveIdx.value + 1) % cmdMatches.value.length;
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowUp") {
      cmdActiveIdx.value =
        (cmdActiveIdx.value - 1 + cmdMatches.value.length) %
        cmdMatches.value.length;
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const c = cmdMatches.value[cmdActiveIdx.value];
      if (c) pickCommand(c.name);
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      cmdMenuOpen.value = false;
      e.preventDefault();
      return;
    }
  }
  if (e.key === "Escape") {
    if (props.busy) {
      emit("cancel");
      e.preventDefault();
    }
    return;
  }
  // Plain Enter submits; Shift+Enter inserts a newline (default behavior).
  if (e.key === "Enter" && !e.shiftKey) {
    submit();
    e.preventDefault();
    return;
  }
  // History recall only when the caret sits at the very start of the input.
  const caretAtStart =
    (textarea.value?.selectionStart ?? 0) === 0 &&
    (textarea.value?.selectionEnd ?? 0) === 0;
  if (e.key === "ArrowUp" && caretAtStart) {
    recallHistory(-1);
    e.preventDefault();
    return;
  }
  if (e.key === "ArrowDown" && historyIdx !== -1 && caretAtStart) {
    recallHistory(1);
    e.preventDefault();
    return;
  }
}

function onInput() {
  historyIdx = -1;
  updateMentionState();
}
</script>

<template>
  <!-- No bottom padding on the form: the parent composer wrapper (ChatPane) owns the bottom
       spacing via max(1rem, env(safe-area-inset-bottom)), so the composer sits flush above the
       iOS home indicator (like native input bars) instead of leaving an extra gap below it. -->
  <!-- No form-level border-t / top padding: ChatPane stacks status/plan against this
       form's top edge, which must be the message card's top border — not a resize-handle
       gutter above it. Separation comes from the card border + ChatPane stack shadows. -->
  <form
    class="relative px-0"
    @submit.prevent="submit"
    @drop.prevent="onDrop"
    @dragover.prevent
  >
    <!-- hidden file picker -->
    <input
      ref="fileInput"
      type="file"
      multiple
      class="hidden"
      data-test="attach-input"
      @change="onFilesPicked"
    />
    <!-- COMPOSER — single elevated card: textarea on top, controls row below.
         `relative` so the slash-command menu can float above the card (bottom-full)
         instead of pushing the textarea down. -->
    <div
      class="relative rounded-lg border border-border bg-surface shadow-e2 focus-within:border-accent/50 transition-colors"
    >
      <!-- Resize handle: thin grab strip on the card's top edge (desktop only). Anchored
           inside the card so status/plan stack layers baseline to the real message-box
           top, not a gutter/handle above it. touch-none keeps a touch from scrolling;
           aria-hidden (pointer-only over rows="2"); title gives a hover hint. -->
      <div
        data-test="composer-resize"
        aria-hidden="true"
        :title="$t('chat.resizeComposer')"
        class="absolute inset-x-0 top-0 z-10 hidden h-2 cursor-row-resize touch-none select-none rounded-t-lg transition-colors lg:block"
        :class="heightDragging ? 'bg-accent/50' : 'hover:bg-accent/30'"
        @pointerdown.prevent="heightResize.onPointerDown"
      />
      <!-- Pending attachment chips -->
      <div
        v-if="composer.pending.length"
        class="flex flex-wrap gap-2 px-2.5 pt-2.5 pb-1"
      >
        <div
          v-for="p in composer.pending"
          :key="p.id"
          class="flex items-center gap-1.5 rounded-md border border-border bg-raised px-2 py-1 text-[12px]"
        >
          <img
            v-if="p.previewUrl"
            :src="p.previewUrl"
            class="h-6 w-6 rounded object-cover"
            :alt="p.filename"
          />
          <span class="max-w-[120px] truncate text-fg">{{ p.filename }}</span>
          <span v-if="p.status === 'uploading'" class="text-fg-muted">…</span>
          <span
            v-else-if="p.status === 'error'"
            class="text-danger font-semibold"
            >!</span
          >
          <button
            type="button"
            :title="$t('chat.attach.remove')"
            class="text-fg-muted hover:text-fg transition-colors"
            @click="composer.removeAttachment(p.id)"
          >
            <X :size="12" />
          </button>
        </div>
      </div>
      <!-- Inline feedback when an attachment is rejected (cap or size limit). -->
      <span
        v-if="composer.rejection"
        data-test="attach-rejected"
        class="block px-3 pt-2 text-xs text-danger"
      >
        {{
          composer.rejection.reason === "too-many"
            ? $t("chat.attach.tooMany")
            : $t("chat.attach.tooLarge", { name: composer.rejection.filename })
        }}
      </span>
      <!-- Agent slash-command autocomplete: floats above the composer card (bottom-full)
           so it never grows the input box; pinned to the card's horizontal edges. -->
      <!-- Agent slash-command autocomplete -->
      <ul
        v-if="cmdMenuOpen && cmdMatches.length"
        data-test="cmd-menu"
        role="listbox"
        class="absolute bottom-full inset-x-2.5 z-20 mb-2 max-h-56 overflow-auto rounded-md border border-border bg-raised py-1 shadow-e2"
      >
        <li
          v-for="(c, i) in cmdMatches"
          :key="c.name"
          data-test="cmd-item"
          role="option"
          :aria-selected="i === cmdActiveIdx"
          class="flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-[13px]"
          :class="i === cmdActiveIdx ? 'bg-accent/10' : ''"
          @mousedown.prevent="pickCommand(c.name)"
          @mouseenter="cmdActiveIdx = i"
        >
          <span class="shrink-0 font-medium text-fg">/{{ c.name }}</span>
          <span v-if="c.description" class="truncate text-fg-muted">{{
            c.description
          }}</span>
        </li>
      </ul>
      <!-- Agent @ mention autocomplete: floats above the composer card -->
      <ul
        v-if="mentionMenuOpen && mentionMatches.length"
        data-test="mention-menu"
        role="listbox"
        class="absolute bottom-full inset-x-2.5 z-20 mb-2 max-h-56 overflow-auto rounded-md border border-border bg-raised py-1 shadow-e2"
      >
        <li
          v-for="(agentItem, i) in mentionMatches"
          :key="agentItem.handle"
          data-test="mention-item"
          role="option"
          :aria-selected="i === mentionActiveIdx"
          class="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-[13px]"
          :class="i === mentionActiveIdx ? 'bg-accent/10' : ''"
          @mousedown.prevent="pickMention(agentItem)"
          @mouseenter="mentionActiveIdx = i"
        >
          <div class="flex min-w-0 flex-1 flex-col">
            <div class="flex min-w-0 items-center justify-between gap-2">
              <span
                class="font-semibold text-accent truncate"
                data-test="mention-primary"
                >@{{ agentItem.displayName }}</span
              >
              <span
                v-if="activityLabel(agentItem.activity)"
                data-test="mention-activity"
                :data-status="agentItem.activity?.status"
                class="shrink-0 text-[11px] font-medium"
                :class="activityClass(agentItem.activity?.status)"
              >
                {{ activityLabel(agentItem.activity) }}
              </span>
            </div>
            <div
              v-if="formatSecondaryLine(agentItem, availableAgents)"
              data-test="mention-secondary"
              class="truncate text-[11px] text-fg-muted"
            >
              {{ formatSecondaryLine(agentItem, availableAgents) }}
            </div>
          </div>
        </li>
      </ul>
      <!-- Stays enabled while busy: sending here queues server-side (no client-side
           blocking) and Esc still cancels the in-flight turn. -->
      <textarea
        ref="textarea"
        v-model="text"
        rows="2"
        class="w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-[16px] lg:text-[14px] leading-relaxed text-fg placeholder:text-fg-muted focus:outline-none"
        :style="isDesktop ? { height: composerHeight + 'px' } : undefined"
        :placeholder="busy ? $t('chat.working') : $t('chat.message')"
        @input="onInput"
        @click="updateMentionState"
        @keyup="updateMentionState"
        @keydown="onKeydown"
        @paste="onPaste"
      />
      <div class="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-0.5">
        <!-- model chip (left) -->
        <div
          v-if="instanceId && sessionAlias"
          class="relative flex min-w-0 flex-1 items-center gap-2"
        >
          <button
            type="button"
            data-test="model-chip"
            class="flex min-w-0 items-center gap-1.5 px-1.5 py-1 rounded-md text-fg-muted hover:bg-raised transition-colors disabled:opacity-60"
            :disabled="!controls.modelAvailable.length"
            @click="toggleModelMenu"
          >
            <Brain :size="14" class="shrink-0 text-accent" />
            <span
              class="min-w-0 truncate font-mono text-[11.5px] font-medium text-fg"
              >{{
                controls.modelCurrent
                  ? formatModelLabel(controls.modelCurrent)
                  : $t("chat.model")
              }}</span
            >
            <ChevronDown
              v-if="controls.modelAvailable.length"
              :size="13"
              class="shrink-0"
            />
          </button>
          <ul
            v-if="modelMenuOpen && controls.modelAvailable.length"
            data-test="model-menu"
            class="absolute bottom-full left-0 z-10 mb-1 max-h-48 min-w-40 overflow-y-auto rounded-lg border border-border bg-raised shadow-lg"
          >
            <li v-for="m in controls.modelAvailable" :key="m">
              <button
                type="button"
                data-test="model-option"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
                :class="
                  m === controls.modelCurrent
                    ? 'bg-accent/10 text-accent'
                    : 'hover:bg-fg/10 text-fg-muted'
                "
                @click="pickModel(m)"
              >
                <span class="font-mono">{{ formatModelLabel(m) }}</span>
                <Check
                  v-if="m === controls.modelCurrent"
                  :size="14"
                  class="ml-auto"
                />
              </button>
            </li>
          </ul>
          <div v-if="controls.effortAvailable.length" class="relative shrink-0">
            <button
              type="button"
              data-test="effort-chip"
              class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-fg-muted transition-colors hover:bg-raised"
              :title="$t('chat.effort')"
              @click="toggleEffortMenu"
            >
              <SlidersHorizontal :size="14" class="text-accent" />
              <span class="font-mono text-[11.5px] font-medium text-fg">{{
                controls.effortCurrent ?? $t("chat.effort")
              }}</span>
              <ChevronDown :size="13" />
            </button>
            <ul
              v-if="effortMenuOpen"
              data-test="effort-menu"
              class="absolute bottom-full left-0 z-10 mb-1 max-h-48 min-w-32 overflow-y-auto rounded-lg border border-border bg-raised shadow-lg"
            >
              <li v-for="effort in controls.effortAvailable" :key="effort">
                <button
                  type="button"
                  data-test="effort-option"
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
                  :class="
                    effort === controls.effortCurrent
                      ? 'bg-accent/10 text-accent'
                      : 'hover:bg-fg/10 text-fg-muted'
                  "
                  @click="pickEffort(effort)"
                >
                  <span class="font-mono">{{ effort }}</span>
                  <Check
                    v-if="effort === controls.effortCurrent"
                    :size="14"
                    class="ml-auto"
                  />
                </button>
              </li>
            </ul>
          </div>
          <!-- context-usage meter: click to open the cost / token-breakdown popover -->
          <button
            v-if="context"
            type="button"
            data-test="context-meter"
            class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded pl-0.5 hover:opacity-80"
            :title="
              $t('chat.contextUsage', {
                used: context.used.toLocaleString(),
                size: context.size.toLocaleString(),
              })
            "
            @click="toggleUsage"
          >
            <Gauge
              :size="13"
              class="shrink-0"
              :class="
                context.tone === 'danger'
                  ? 'text-danger'
                  : context.tone === 'warn'
                    ? 'text-warn'
                    : 'text-accent'
              "
            />
            <span
              class="relative h-1 w-8 shrink-0 overflow-hidden rounded-full bg-border"
            >
              <span
                class="absolute inset-y-0 left-0 rounded-full"
                :class="
                  context.tone === 'danger'
                    ? 'bg-danger'
                    : context.tone === 'warn'
                      ? 'bg-warn'
                      : 'bg-accent'
                "
                :style="{ width: context.pct + '%' }"
              />
            </span>
            <span
              class="shrink-0 text-[11.5px] font-medium tabular-nums text-fg-muted"
              >{{ context.pct }}%</span
            >
          </button>
          <UsagePopover
            v-if="context && usageOpen"
            :used="context.used"
            :size="context.size"
            :pct="context.pct"
            :cost="context.cost"
            :breakdown="context.breakdown"
            :anchor="usageAnchor"
            @dismiss="usageOpen = false"
          />
        </div>
        <span v-else />

        <!-- send / stop (right) -->
        <div class="flex shrink-0 items-center gap-1.5">
          <!-- attach button -->
          <button
            type="button"
            data-test="attach-btn"
            :title="$t('chat.attach.add')"
            class="flex items-center gap-1.5 px-1.5 py-1 rounded-md text-fg-muted hover:bg-raised transition-colors"
            @click="openPicker"
          >
            <Paperclip :size="15" />
          </button>
          <button
            type="submit"
            data-test="composer-send"
            :disabled="
              composer.uploading ||
              (!text.trim() &&
                !composer.pending.filter((p) => p.status === 'ready').length)
            "
            class="flex items-center gap-1.5 whitespace-nowrap pl-3 pr-2.5 py-1.5 rounded-md bg-accent text-white text-[12.5px] font-semibold shadow-e1 hover:bg-accent-hover hover:shadow-e2 transition-all disabled:bg-fg/10 disabled:text-fg-muted disabled:shadow-none"
          >
            {{ $t("chat.send") }}
            <Send :size="14" />
          </button>
        </div>
      </div>
    </div>
  </form>
</template>
