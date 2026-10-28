<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ArrowUp, Loader2, Square } from "lucide-vue-next";

/**
 * The composer card every pane shares: one rounded surface with a growing textarea,
 * a controls row below it, and a send button that becomes Stop while a turn runs.
 *
 * Panes mount their own affordances (attachment picker, model chip, target picker,
 * slash menus) through the `menus` and `controls` slots.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** A turn is running: the button becomes Stop (with stopWhileBusy, always —
     *  even with sendable text; otherwise only an empty composer cancels). */
    busy?: boolean;
    disabled?: boolean;
    /** A send is in flight: the button shows a spinner and ignores clicks. */
    sending?: boolean;
    /** Cancelling: the stop button shows a spinner and ignores clicks. */
    cancelling?: boolean;
    placeholder?: string;
    /** Fixed textarea height in px. Omit to let the textarea grow with content. */
    height?: number;
    /** Test hook for the send button, so each pane keeps its own selector. */
    sendTestId?: string;
    /** Test hook for the stop button. */
    stopTestId?: string;
    /** Test hook for the textarea. */
    textareaTestId?: string;
    /** Pane-specific extra guard on Send (e.g. a resolvable target is required). */
    sendDisabled?: boolean;
    /** Attachments slot needs extra guard on Send (e.g. an upload still in flight). */
    attachmentsSendDisabled?: boolean;
    /** True when attachments are staged: an empty body sends instead of stopping. */
    hasAttachments?: boolean;
    /** Busy keeps the Stop button even with sendable text. Panes whose sends
     *  queue server-side mid-run must leave this off. */
    stopWhileBusy?: boolean;
    /** The pane drives an ARIA combobox from its completion menu. */
    combobox?: boolean;
    /** Element id of the pane's completion listbox. */
    comboboxListId?: string;
    /** Whether the completion menu is open (drives aria-expanded). */
    comboboxExpanded?: boolean;
    /** Id of the active option, when a completion menu is open. */
    comboboxActiveId?: string;
  }>(),
  { busy: false, disabled: false, sending: false, cancelling: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** Text changed, carrying the new value synchronously. */
  input: [value: string];
  send: [];
  cancel: [];
  keydown: [event: KeyboardEvent];
  paste: [event: ClipboardEvent];
  /** Files dragged onto the composer card. */
  drop: [event: DragEvent];
  /** IME composition started. Completions stay closed while it is active. */
  compositionstart: [];
  compositionend: [];
  /** Focus left the textarea. */
  blur: [];
  /** Caret moved inside the textarea. Panes use it for completion queries. */
  caret: [selection: { start: number; end: number }];
}>();

const textarea = ref<HTMLTextAreaElement | null>(null);

const hasSendable = computed(() => props.modelValue.trim().length > 0 || props.hasAttachments === true);
/** Plainly unavailable (e.g. a Group with zero Topics): dim the whole card and
 *  show not-allowed. A running turn (Stop must stay prominent) or an in-flight
 *  send (spinner) keeps the card at full strength and only dims the textarea. */
const surfaceDisabled = computed(() => props.disabled && !props.busy && !props.sending);
/** While a turn runs the button is Stop. Default: only when the composer has
 *  nothing sendable (queues-while-busy panes keep Send for typed text).
 *  stopWhileBusy panes refuse to send mid-run entirely, so the button stays
 *  Stop and the click routes to @cancel. */
const showStop = computed(() => props.busy && (props.stopWhileBusy === true || !hasSendable.value));

function reportCaret(): void {
  const el = textarea.value;
  if (!el) return;
  emit("caret", { start: el.selectionStart, end: el.selectionEnd });
}

function focus(): void {
  textarea.value?.focus();
}

function setSelectionRange(start: number, end: number): void {
  textarea.value?.setSelectionRange(start, end);
}

defineExpose({ focus, setSelectionRange });

watch(() => props.modelValue, (value) => {
  // A pane-set value (send clears, history recall fills) needs the caret reported
  // too, or pane keyboard logic reads a stale position.
  emit("caret", { start: value.length, end: value.length });
  void nextTick(resize);
});

function resize(): void {
  const el = textarea.value;
  if (!el) return;
  // A fixed height (the session pane's drag handle) overrides the auto-grow.
  if (props.height !== undefined) {
    el.style.height = `${props.height}px`;
    return;
  }
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

function onInput(event: Event): void {
  const el = event.target as HTMLTextAreaElement;
  const value = el.value;
  emit("update:modelValue", value);
  emit("input", value);
  emit("caret", { start: el.selectionStart, end: el.selectionEnd });
  resize();
}
</script>

<template>
  <!-- No bottom padding or border-t on the form: the pane owns the bottom spacing,
       and stack layers above this card baseline to its top border. -->
  <form class="relative px-0" @submit.prevent="emit('send')" @dragover.prevent @drop="emit('drop', $event)">
    <div
      data-test="composer-surface"
      class="relative rounded-2xl bg-surface transition-colors focus-within:ring-2 focus-within:ring-accent"
      :class="surfaceDisabled ? 'cursor-not-allowed opacity-60' : ''"
      :aria-disabled="surfaceDisabled ? 'true' : undefined"
    >
      <slot name="menus" />
      <slot name="attachments" />

      <textarea
        ref="textarea"
        :data-test="textareaTestId"
        data-ring="container"
        :value="modelValue"
        rows="2"
        :role="combobox ? 'combobox' : undefined"
        :aria-autocomplete="combobox ? 'list' : undefined"
        :aria-controls="combobox ? comboboxListId : undefined"
        :aria-expanded="combobox ? comboboxExpanded : undefined"
        :aria-activedescendant="combobox ? comboboxActiveId : undefined"
        class="w-full resize-none bg-transparent px-3.5 pt-2.5 pb-1 text-base lg:text-sm leading-relaxed text-fg placeholder:text-sm lg:placeholder:text-ui placeholder:text-fg-muted focus:outline-none disabled:cursor-not-allowed"
        :class="surfaceDisabled ? '' : 'disabled:opacity-50'"
        :disabled="disabled"
        :style="height !== undefined ? { height: height + 'px' } : undefined"
        :placeholder="placeholder || $t('chat.message')"
        @input="onInput"
        @keydown="emit('keydown', $event)"
        @keyup="reportCaret"
        @click="reportCaret"
        @select="reportCaret"
        @compositionstart="emit('compositionstart')"
        @compositionend="emit('compositionend')"
        @blur="emit('blur')"
        @paste="emit('paste', $event)"
      />

      <div class="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-0.5">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <slot name="controls" />
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <slot name="actions" />
          <button
            v-if="showStop"
            type="button"
            :data-test="stopTestId"
            :aria-label="$t('common.cancel')"
            :title="$t('common.cancel')"
            :disabled="cancelling"
            class="grid h-11 w-11 lg:h-7 lg:w-7 shrink-0 place-items-center rounded-sm bg-danger text-on-danger transition-all hover:opacity-90 disabled:opacity-50"
            @click="emit('cancel')"
          >
            <Loader2 v-if="cancelling" :size="12" class="animate-spin" />
            <Square v-else :size="10" fill="currentColor" />
          </button>
          <button
            v-else
            type="submit"
            :data-test="sendTestId"
            :disabled="disabled || sending || sendDisabled || attachmentsSendDisabled || !hasSendable"
            :aria-label="$t('chat.send')"
            :title="$t('chat.send')"
            class="grid h-11 w-11 lg:h-7 lg:w-7 shrink-0 place-items-center rounded-sm bg-accent text-on-accent transition-all hover:bg-accent-hover disabled:bg-fg/10 disabled:text-fg-muted"
            @click="emit('send')"
          >
            <Loader2 v-if="sending" :size="12" class="animate-spin" />
            <ArrowUp v-else :size="13" :stroke-width="2.5" />
          </button>
        </div>
      </div>
    </div>
  </form>
</template>
