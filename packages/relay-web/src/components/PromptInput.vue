<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Brain, Check, ChevronDown, Gauge, Send } from "lucide-vue-next";
import { loadDraft, saveDraft } from "../lib/composer-drafts";
import { useComposerStore } from "../stores/composer";
import { useSessionControlsStore } from "../stores/session-controls";
import { useChatStore } from "../stores/chat";

const props = defineProps<{ busy?: boolean; draftKey?: string; instanceId?: string | null; sessionAlias?: string | null }>();
const emit = defineEmits<{ send: [text: string]; cancel: [] }>();

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
  return { used: u.used, size: u.size, pct, tone };
});

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
  const value = text.value.trim();
  if (!value) return;
  emit("send", value);
  if (history.value[history.value.length - 1] !== value) history.value.push(value);
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
  <form class="relative border-t border-border px-0 py-3 lg:p-3" @submit.prevent="submit">
    <!-- COMPOSER — single elevated card: textarea on top, controls row below. -->
    <div class="rounded-lg border border-border bg-surface shadow-e2 focus-within:border-accent/50 transition-colors">
      <!-- Stays enabled while busy so you can pre-compose the next message and press
           Esc to stop; submit() itself no-ops while busy. -->
      <textarea ref="textarea" v-model="text" rows="2"
                class="w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-[16px] lg:text-[14px] leading-relaxed text-fg placeholder:text-fg-muted focus:outline-none"
                :placeholder='busy ? $t("chat.working") : $t("chat.message")'
                @input="onInput"
                @keydown="onKeydown" />
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
          <!-- context-usage meter: sits to the right of the model chip -->
          <span v-if="context" data-test="context-meter"
                class="flex shrink-0 items-center gap-1.5 whitespace-nowrap pl-0.5"
                :title="$t('chat.contextUsage', { used: context.used.toLocaleString(), size: context.size.toLocaleString() })">
            <Gauge :size="13" class="shrink-0"
                   :class="context.tone === 'danger' ? 'text-danger' : context.tone === 'warn' ? 'text-warn' : 'text-accent'" />
            <span class="relative h-1 w-8 shrink-0 overflow-hidden rounded-full bg-border">
              <span class="absolute inset-y-0 left-0 rounded-full"
                    :class="context.tone === 'danger' ? 'bg-danger' : context.tone === 'warn' ? 'bg-warn' : 'bg-accent'"
                    :style="{ width: context.pct + '%' }" />
            </span>
            <span class="shrink-0 text-[11.5px] font-medium tabular-nums text-fg-muted">{{ context.pct }}%</span>
          </span>
        </div>
        <span v-else />

        <!-- send / stop (right) -->
        <button v-if="busy" type="button" data-test="composer-stop"
                class="flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 rounded-md bg-danger text-white text-[12.5px] font-semibold hover:opacity-90 transition-all"
                @click="emit('cancel')">{{ $t("chat.stop") }}</button>
        <button v-else type="submit" data-test="composer-send" :disabled="!text.trim()"
                class="flex items-center gap-1.5 pl-3 pr-2.5 py-1.5 rounded-md bg-accent text-white text-[12.5px] font-semibold shadow-e1 hover:bg-accent-hover hover:shadow-e2 transition-all disabled:bg-fg/10 disabled:text-fg-muted disabled:shadow-none">
          {{ $t("chat.send") }}
          <Send :size="14" />
        </button>
      </div>
    </div>
  </form>
</template>
