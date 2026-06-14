<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { suggestCommands } from "../lib/command-catalog";
import { loadDraft, saveDraft } from "../lib/composer-drafts";

const props = defineProps<{ busy?: boolean; draftKey?: string }>();
const emit = defineEmits<{ send: [text: string]; cancel: [] }>();

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

// Sent-message history (↑/↓ recall, à la a shell prompt).
const history = ref<string[]>([]);
let historyIdx = -1; // -1 = editing a fresh line

// Slash-command autocomplete popover.
const suggestions = computed(() => suggestCommands(text.value));
const showSuggestions = ref(false);
const activeIdx = ref(0);
function refreshSuggestions() {
  showSuggestions.value = suggestions.value.length > 0;
  activeIdx.value = 0;
}

function submit() {
  if (props.busy) return;
  const value = text.value.trim();
  if (!value) return;
  emit("send", value);
  if (history.value[history.value.length - 1] !== value) history.value.push(value);
  historyIdx = -1;
  text.value = "";
  showSuggestions.value = false;
}

function acceptSuggestion(i = activeIdx.value) {
  const s = suggestions.value[i];
  if (!s) return;
  text.value = s.name + " ";
  showSuggestions.value = false;
  void nextTick(() => textarea.value?.focus());
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
    if (showSuggestions.value) { showSuggestions.value = false; e.preventDefault(); return; }
    if (props.busy) { emit("cancel"); e.preventDefault(); }
    return;
  }
  if (showSuggestions.value) {
    if (e.key === "ArrowDown") { activeIdx.value = (activeIdx.value + 1) % suggestions.value.length; e.preventDefault(); return; }
    if (e.key === "ArrowUp") { activeIdx.value = (activeIdx.value - 1 + suggestions.value.length) % suggestions.value.length; e.preventDefault(); return; }
    if (e.key === "Tab") { acceptSuggestion(); e.preventDefault(); return; }
    if (e.key === "Enter" && !e.shiftKey) { acceptSuggestion(); e.preventDefault(); return; }
  }
  // Plain Enter submits; Shift+Enter inserts a newline (default behavior).
  if (e.key === "Enter" && !e.shiftKey) { submit(); e.preventDefault(); return; }
  // History recall only when not navigating a popover and the caret sits at the start.
  const caretAtStart = (textarea.value?.selectionStart ?? 0) === 0 && (textarea.value?.selectionEnd ?? 0) === 0;
  if (e.key === "ArrowUp" && caretAtStart) { recallHistory(-1); e.preventDefault(); return; }
  if (e.key === "ArrowDown" && historyIdx !== -1 && caretAtStart) { recallHistory(1); e.preventDefault(); return; }
}

function onInput() {
  historyIdx = -1;
  refreshSuggestions();
}
</script>

<template>
  <form class="relative border-t p-3" @submit.prevent="submit">
    <!-- Suggestion popover, anchored above the input. -->
    <ul v-if="showSuggestions" data-test="cmd-suggestions"
        class="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
      <li v-for="(s, i) in suggestions" :key="s.name">
        <button type="button" data-test="cmd-suggestion"
                class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm"
                :class="i === activeIdx ? 'bg-sky-50' : 'hover:bg-slate-50'"
                @mousedown.prevent="acceptSuggestion(i)">
          <span class="font-mono font-medium text-slate-700">{{ s.name }}</span>
          <span class="truncate text-xs text-slate-400">{{ s.hint }}</span>
        </button>
      </li>
    </ul>

    <div class="flex items-end gap-2">
      <!-- Stays enabled while busy so you can pre-compose the next message and press
           Esc to stop; submit() itself no-ops while busy. -->
      <textarea ref="textarea" v-model="text" rows="2"
                class="w-full resize-none rounded border px-3 py-2 text-sm"
                :placeholder="busy ? 'Agent is working… (Esc to stop)' : 'Message, or /command'"
                @input="onInput"
                @keydown="onKeydown"
                @blur="showSuggestions = false" />
      <button v-if="busy" type="button" data-test="composer-stop"
              class="shrink-0 rounded bg-red-500 px-3 py-2 text-sm font-medium text-white hover:bg-red-600"
              @click="emit('cancel')">Stop</button>
      <button v-else type="submit" data-test="composer-send" :disabled="!text.trim()"
              class="shrink-0 rounded bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:bg-slate-200 disabled:text-slate-400">Send</button>
    </div>
  </form>
</template>
