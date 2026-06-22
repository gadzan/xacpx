<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Brain, Check, ChevronDown, Gauge, Paperclip, Send, X } from "lucide-vue-next";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import { loadDraft, saveDraft } from "../lib/composer-drafts";
import UsagePopover from "./UsagePopover.vue";
import { useComposerStore } from "../stores/composer";
import { useSessionControlsStore } from "../stores/session-controls";
import { useChatStore } from "../stores/chat";

const props = defineProps<{ busy?: boolean; draftKey?: string; instanceId?: string | null; sessionAlias?: string | null }>();
const emit = defineEmits<{ send: [text: string, media: PromptAttachmentRef[]]; cancel: [] }>();

const composer = useComposerStore();
const controls = useSessionControlsStore();
const chat = useChatStore();

// Context-usage meter (ACP usage_update) for the current session. Null when the agent
// doesn't report it (e.g. codex) or the window is unknown — the chip then hides.
const context = computed(() => {
  const u = chat.sessionUsage;
  if (!u || u.size <= 0) return null;
  const pct = Math.min(100, Math.round((u.used / u.size) * 100));
  const tone = pct >= 90 ? "danger" : pct >= 75 ? "warn" : "accent";
  return { used: u.used, size: u.size, pct, tone, cost: u.cost, breakdown: u.breakdown };
});

// Click the meter to open a popover with the cost & per-turn token breakdown.
const usageOpen = ref(false);
const usageAnchor = ref<{ top: number; left: number; width: number; height: number } | null>(null);
function toggleUsage(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  usageAnchor.value = { top: r.top, left: r.left, width: r.width, height: r.height };
  usageOpen.value = !usageOpen.value;
}

// Load the session's model for the composer chip whenever the session changes.
const modelMenuOpen = ref(false);
watch(
  () => [props.instanceId, props.sessionAlias] as const,
  ([id, alias]) => { void controls.loadModel(id ?? null, alias ?? null); modelMenuOpen.value = false; },
  { immediate: true },
);
async function pickModel(id: string) {
  modelMenuOpen.value = false;
  if (props.instanceId && props.sessionAlias) await controls.setModel(props.instanceId, props.sessionAlias, id);
}
const text = ref(loadDraft(props.draftKey ?? ""));
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

// Agent slash-command autocomplete: when the composer holds a single `/`-token, offer the
// session's advertised commands. Selecting one inserts `/name `; it then sends as a normal
// prompt (the agent interprets it). No commands / no match → no menu, composer unchanged.
const cmdMenuOpen = ref(false);
const cmdActiveIdx = ref(0);
const cmdQuery = computed(() => {
  const v = text.value;
  if (!v.startsWith("/") || v.includes("\n") || v.slice(1).includes(" ")) return null;
  return v.slice(1).toLowerCase();
});
const cmdMatches = computed(() => {
  const q = cmdQuery.value;
  if (q === null) return [];
  return chat.sessionCommands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
});
watch(cmdMatches, (m) => { cmdMenuOpen.value = m.length > 0; cmdActiveIdx.value = 0; });
function pickCommand(name: string) {
  text.value = `/${name} `;
  cmdMenuOpen.value = false;
  void nextTick(() => textarea.value?.focus());
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
watch(text, (t) => saveDraft(props.draftKey ?? "", t));
watch(
  () => props.draftKey,
  (next, prev) => {
    if (prev) saveDraft(prev, text.value);
    text.value = loadDraft(next ?? "");
  },
);

// External insert requests (e.g. command palette) targeted at this session.
watch(
  () => composer.insertRequest,
  (req) => {
    if (!req || req.key !== (props.draftKey ?? "")) return;
    text.value = text.value.trim() ? `${text.value.trimEnd()} ${req.text}` : req.text;
    void nextTick(() => textarea.value?.focus());
  },
);

// Sent-message history (↑/↓ recall, à la a shell prompt).
const history = ref<string[]>([]);
let historyIdx = -1; // -1 = editing a fresh line

function submit() {
  if (props.busy) return;
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
  emit("send", value, media);
  composer.clearAttachments();
  if (value && history.value[history.value.length - 1] !== value) history.value.push(value);
  historyIdx = -1;
  text.value = "";
}

function recallHistory(dir: -1 | 1) {
  if (history.value.length === 0) return;
  if (dir === -1) {
    historyIdx = historyIdx === -1 ? history.value.length - 1 : Math.max(0, historyIdx - 1);
  } else {
    if (historyIdx === -1) return;
    historyIdx = historyIdx + 1;
    if (historyIdx >= history.value.length) { historyIdx = -1; text.value = ""; return; }
  }
  text.value = history.value[historyIdx];
}

function onKeydown(e: KeyboardEvent) {
  // IME guard: never intercept keys mid-composition (CJK input) — Enter here confirms
  // the candidate, it must not submit. `isComposing` covers all input engines.
  if (e.isComposing) return;
  // Command autocomplete takes the arrow/enter/tab/esc keys while its menu is open.
  if (cmdMenuOpen.value && cmdMatches.value.length > 0) {
    if (e.key === "ArrowDown") { cmdActiveIdx.value = (cmdActiveIdx.value + 1) % cmdMatches.value.length; e.preventDefault(); return; }
    if (e.key === "ArrowUp") { cmdActiveIdx.value = (cmdActiveIdx.value - 1 + cmdMatches.value.length) % cmdMatches.value.length; e.preventDefault(); return; }
    if (e.key === "Enter" || e.key === "Tab") { const c = cmdMatches.value[cmdActiveIdx.value]; if (c) pickCommand(c.name); e.preventDefault(); return; }
    if (e.key === "Escape") { cmdMenuOpen.value = false; e.preventDefault(); return; }
  }
  if (e.key === "Escape") {
    if (props.busy) { emit("cancel"); e.preventDefault(); }
    return;
  }
  // Plain Enter submits; Shift+Enter inserts a newline (default behavior).
  if (e.key === "Enter" && !e.shiftKey) { submit(); e.preventDefault(); return; }
  // History recall only when the caret sits at the very start of the input.
  const caretAtStart = (textarea.value?.selectionStart ?? 0) === 0 && (textarea.value?.selectionEnd ?? 0) === 0;
  if (e.key === "ArrowUp" && caretAtStart) { recallHistory(-1); e.preventDefault(); return; }
  if (e.key === "ArrowDown" && historyIdx !== -1 && caretAtStart) { recallHistory(1); e.preventDefault(); return; }
}

function onInput() {
  historyIdx = -1;
}
</script>

<template>
  <!-- pb keeps the existing padding and adds the iOS home-indicator safe area so
       the composer is not overlapped at the bottom of an installed PWA (env() is 0
       on desktop / non-PWA, so the padding is unchanged there). -->
  <form class="relative border-t border-border px-0 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:p-3 lg:pb-[calc(0.75rem+env(safe-area-inset-bottom))]" @submit.prevent="submit"
        @drop.prevent="onDrop" @dragover.prevent>
    <!-- hidden file picker -->
    <input ref="fileInput" type="file" multiple class="hidden" data-test="attach-input" @change="onFilesPicked" />
    <!-- COMPOSER — single elevated card: textarea on top, controls row below. -->
    <div class="rounded-lg border border-border bg-surface shadow-e2 focus-within:border-accent/50 transition-colors">
      <!-- Pending attachment chips -->
      <div v-if="composer.pending.length" class="flex flex-wrap gap-2 px-2.5 pt-2.5 pb-1">
        <div v-for="p in composer.pending" :key="p.id"
             class="flex items-center gap-1.5 rounded-md border border-border bg-raised px-2 py-1 text-[12px]">
          <img v-if="p.previewUrl" :src="p.previewUrl" class="h-6 w-6 rounded object-cover" :alt="p.filename" />
          <span class="max-w-[120px] truncate text-fg">{{ p.filename }}</span>
          <span v-if="p.status === 'uploading'" class="text-fg-muted">…</span>
          <span v-else-if="p.status === 'error'" class="text-danger font-semibold">!</span>
          <button type="button" :title="$t('chat.attach.remove')" class="text-fg-muted hover:text-fg transition-colors"
                  @click="composer.removeAttachment(p.id)"><X :size="12" /></button>
        </div>
      </div>
      <!-- Inline feedback when an attachment is rejected (cap or size limit). -->
      <span v-if="composer.rejection" data-test="attach-rejected" class="block px-3 pt-2 text-xs text-danger">
        {{ composer.rejection.reason === 'too-many' ? $t('chat.attach.tooMany') : $t('chat.attach.tooLarge', { name: composer.rejection.filename }) }}
      </span>
      <!-- Agent slash-command autocomplete -->
      <ul v-if="cmdMenuOpen && cmdMatches.length" data-test="cmd-menu" role="listbox"
          class="mx-2.5 mt-2 max-h-56 overflow-auto rounded-md border border-border bg-raised py-1 shadow-e2">
        <li v-for="(c, i) in cmdMatches" :key="c.name"
            data-test="cmd-item" role="option" :aria-selected="i === cmdActiveIdx"
            class="flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-[13px]"
            :class="i === cmdActiveIdx ? 'bg-accent/10' : ''"
            @mousedown.prevent="pickCommand(c.name)"
            @mouseenter="cmdActiveIdx = i">
          <span class="shrink-0 font-medium text-fg">/{{ c.name }}</span>
          <span v-if="c.description" class="truncate text-fg-muted">{{ c.description }}</span>
        </li>
      </ul>
      <!-- Stays enabled while busy so you can pre-compose the next message and press
           Esc to stop; submit() itself no-ops while busy. -->
      <textarea ref="textarea" v-model="text" rows="2"
                class="w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-[16px] lg:text-[14px] leading-relaxed text-fg placeholder:text-fg-muted focus:outline-none"
                :placeholder='busy ? $t("chat.working") : $t("chat.message")'
                @input="onInput"
                @keydown="onKeydown"
                @paste="onPaste" />
      <div class="flex items-center justify-between px-2.5 pb-2.5 pt-0.5">
        <!-- model chip (left) -->
        <div v-if="instanceId && sessionAlias" class="relative flex items-center gap-2">
          <button type="button" data-test="model-chip"
                  class="flex items-center gap-1.5 px-1.5 py-1 rounded-md text-fg-muted hover:bg-raised transition-colors disabled:opacity-60"
                  :disabled="!controls.available.length"
                  @click="modelMenuOpen = !modelMenuOpen">
            <Brain :size="14" class="text-accent" />
            <span class="font-mono text-[11.5px] font-medium text-fg">{{ controls.current || $t("chat.model") }}</span>
            <ChevronDown v-if="controls.available.length" :size="13" />
          </button>
          <ul v-if="modelMenuOpen && controls.available.length" data-test="model-menu"
              class="absolute bottom-full left-0 z-10 mb-1 max-h-48 min-w-40 overflow-y-auto rounded-lg border border-border bg-raised shadow-lg">
            <li v-for="m in controls.available" :key="m">
              <button type="button" data-test="model-option"
                      class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
                      :class="m === controls.current ? 'bg-accent/10 text-accent' : 'hover:bg-fg/10 text-fg-muted'"
                      @click="pickModel(m)">
                <span class="font-mono">{{ m }}</span>
                <Check v-if="m === controls.current" :size="14" class="ml-auto" />
              </button>
            </li>
          </ul>
          <span v-if="controls.error" data-test="model-error" class="text-xs text-danger">{{ controls.error }}</span>
          <!-- context-usage meter: click to open the cost / token-breakdown popover -->
          <button v-if="context" type="button" data-test="context-meter"
                  class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded pl-0.5 hover:opacity-80"
                  :title="$t('chat.contextUsage', { used: context.used.toLocaleString(), size: context.size.toLocaleString() })"
                  @click="toggleUsage">
            <Gauge :size="13" class="shrink-0"
                   :class="context.tone === 'danger' ? 'text-danger' : context.tone === 'warn' ? 'text-warn' : 'text-accent'" />
            <span class="relative h-1 w-8 shrink-0 overflow-hidden rounded-full bg-border">
              <span class="absolute inset-y-0 left-0 rounded-full"
                    :class="context.tone === 'danger' ? 'bg-danger' : context.tone === 'warn' ? 'bg-warn' : 'bg-accent'"
                    :style="{ width: context.pct + '%' }" />
            </span>
            <span class="shrink-0 text-[11.5px] font-medium tabular-nums text-fg-muted">{{ context.pct }}%</span>
          </button>
          <UsagePopover v-if="context && usageOpen"
                        :used="context.used" :size="context.size" :pct="context.pct"
                        :cost="context.cost" :breakdown="context.breakdown" :anchor="usageAnchor"
                        @dismiss="usageOpen = false" />
        </div>
        <span v-else />

        <!-- send / stop (right) -->
        <div class="flex items-center gap-1.5">
          <!-- attach button -->
          <button type="button" data-test="attach-btn" :title="$t('chat.attach.add')"
                  class="flex items-center gap-1.5 px-1.5 py-1 rounded-md text-fg-muted hover:bg-raised transition-colors"
                  @click="openPicker">
            <Paperclip :size="15" />
          </button>
          <button v-if="busy" type="button" data-test="composer-stop"
                  class="flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 rounded-md bg-danger text-white text-[12.5px] font-semibold hover:opacity-90 transition-all"
                  @click="emit('cancel')">{{ $t("chat.stop") }}</button>
          <button v-else type="submit" data-test="composer-send" :disabled="composer.uploading || (!text.trim() && !composer.pending.filter(p => p.status === 'ready').length)"
                  class="flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 rounded-md bg-accent text-white text-[12.5px] font-semibold shadow-e1 hover:bg-accent-hover hover:shadow-e2 transition-all disabled:bg-fg/10 disabled:text-fg-muted disabled:shadow-none">
            {{ $t("chat.send") }}
            <Send :size="14" />
          </button>
        </div>
      </div>
    </div>
  </form>
</template>
