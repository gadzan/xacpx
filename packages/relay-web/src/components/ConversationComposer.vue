<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useSlots, watch } from "vue";
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

/** Empty and unfocused: one line. Focus, content or staged attachments: the
 *  familiar two-line card. Focus/blur drives it because a tap on the card is the
 *  intent to write, and content must never be clipped (values also arrive from
 *  send-clear, history recall and restored drafts). */
const focused = ref(false);
const expanded = computed(() => focused.value || props.modelValue.length > 0 || props.hasAttachments === true || showStop.value);
/** Off until the first apply: the initial rows=2 markup must not animate down. */
const animateHeight = ref(false);
/** Panes without any controls/actions slot (the direct Bot composer) render no
 *  affordance row at all, focused or not. */
const slots = useSlots();
const hasAffordances = computed(() => !!slots.controls || !!slots.actions);

watch(() => props.modelValue, (value) => {
  // A pane-set value (send clears, history recall fills) needs the caret reported
  // too, or pane keyboard logic reads a stale position.
  emit("caret", { start: value.length, end: value.length });
  void nextTick(applyHeight);
});
// flush post: the compact/expanded padding classes must be in the DOM before the
// height floor is measured from computed styles.
watch([expanded, () => props.height], () => applyHeight(), { flush: "post" });

function applyHeight(): void {
  const el = textarea.value;
  if (!el) return;
  // A fixed height (the session pane's drag handle) overrides the auto-grow.
  if (props.height !== undefined) {
    el.style.height = `${props.height}px`;
    return;
  }
  const style = getComputedStyle(el);
  // jsdom reports no line-height and a 0 scrollHeight, so every term has a fallback.
  const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 22;
  const box = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const previous = el.style.height;
  el.style.height = "auto";
  const content = Math.min(el.scrollHeight || 0, 200);
  el.style.height = previous;
  const floor = line * (expanded.value ? 2 : 1) + box;
  el.style.height = `${Math.max(content, floor)}px`;
}

onMounted(() => {
  applyHeight();
  // One frame later: from here on the height change is animated.
  requestAnimationFrame(() => { animateHeight.value = true; });
});

function onFocus(): void {
  focused.value = true;
}

function onBlur(): void {
  focused.value = false;
  emit("blur");
}

function onInput(event: Event): void {
  const el = event.target as HTMLTextAreaElement;
  const value = el.value;
  emit("update:modelValue", value);
  emit("input", value);
  emit("caret", { start: el.selectionStart, end: el.selectionEnd });
  applyHeight();
}
</script>

<template>
  <!-- mx-auto max-w-3xl: the transcript column is max-w-3xl centered
       (ConversationMessageList), so the composer sits in the same column instead
       of stretching edge to edge on wide screens. The pane owns bottom spacing
       and stack layers above this card baseline (no pb / border-t here).
       rounded-3xl reads as a pill on the one-line resting card (42px) and stays
       soft on the expanded card. -->
  <form class="relative mx-auto w-full max-w-3xl px-0" @submit.prevent="emit('send')" @dragover.prevent @drop="emit('drop', $event)">
    <div
      data-test="composer-surface"
      class="relative bg-surface transition-[background-color,border-radius] duration-200 ease-out focus-within:ring-2 focus-within:ring-accent"
      :class="[expanded ? 'rounded-2xl' : 'rounded-3xl', surfaceDisabled ? 'cursor-not-allowed opacity-60' : '']"
      :aria-disabled="surfaceDisabled ? 'true' : undefined"
    >
      <!-- Send/stop live INSIDE the input line (WhatsApp style): the resting card is
           one text line tall and the button is its own height reference — both are
           centred with the same 6px inset the placeholder uses, so a 38px pill has
           equal gaps top/bottom/left/right. Expanded, the button drops to the
           bottom-right corner of the grown textarea. The affordance row below
           (model chip, member selector, attach) only exists when a pane passes it
           and folds away while the composer rests (v-show: pane state survives the
           fold). Padding is not animated and the textarea keeps a constant pr-12,
           so applyHeight always measures a settled box. -->
      <div class="relative">
        <slot name="menus" />
        <!-- Staged-image previews and the picker entry fold with the composer:
             staging anything flips hasAttachments -> expanded, so previews are
             never clipped by the fold. -->
        <div v-if="slots.attachments" data-test="composer-attachments-fold"
             class="overflow-hidden transition-[max-height,opacity,visibility] duration-200 ease-out motion-reduce:transition-none"
             :class="expanded ? 'visible max-h-40 opacity-100' : 'invisible max-h-0 opacity-0'">
          <slot name="attachments" />
        </div>

        <textarea
          ref="textarea"
          :data-test="textareaTestId"
          data-ring="container"
          :value="modelValue"
          rows="1"
          :role="combobox ? 'combobox' : undefined"
          :aria-autocomplete="combobox ? 'list' : undefined"
          :aria-controls="combobox ? comboboxListId : undefined"
          :aria-expanded="combobox ? comboboxExpanded : undefined"
          :aria-activedescendant="combobox ? comboboxActiveId : undefined"
          class="block w-full resize-none bg-transparent pr-12 text-base lg:text-sm leading-relaxed text-fg placeholder:text-sm lg:placeholder:text-ui placeholder:text-fg-muted focus:outline-none disabled:cursor-not-allowed"
          :class="[surfaceDisabled ? '' : 'disabled:opacity-50', expanded ? 'pl-3.5 pt-2.5 pb-1' : 'pl-1.5 pt-1.5 pb-1.5', animateHeight ? 'transition-[height] duration-200 ease-out motion-reduce:transition-none' : '']"
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
          @focus="onFocus"
          @blur="onBlur"
          @paste="emit('paste', $event)"
        />

        <div class="absolute flex items-center gap-1.5" :class="expanded ? 'bottom-2 right-2' : 'right-2 top-1/2 -translate-y-1/2'">
          <button
            v-if="showStop"
            type="button"
            :data-test="stopTestId"
            :aria-label="$t('common.cancel')"
            :title="$t('common.cancel')"
            :disabled="cancelling"
            class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-danger text-on-danger transition-all hover:opacity-90 disabled:opacity-50"
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
            class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-on-accent transition-all hover:bg-accent-hover disabled:bg-fg/10 disabled:text-fg-muted"
            @click="emit('send')"
          >
            <Loader2 v-if="sending" :size="12" class="animate-spin" />
            <ArrowUp v-else :size="13" :stroke-width="2.5" />
          </button>
        </div>
      </div>

      <!-- The fold animates max-height/opacity/visibility instead of v-show: a
           display:none toggle is what made focus look instant. visibility keeps the
           hidden controls unfocusable while still transitioning. -->
      <div v-if="hasAffordances" data-test="composer-affordances"
           class="flex items-center gap-2 overflow-hidden px-2.5 transition-[max-height,opacity,padding,visibility] duration-200 ease-out motion-reduce:transition-none"
           :class="expanded ? 'visible max-h-16 opacity-100 pb-2 pt-0.5' : 'invisible max-h-0 opacity-0 pb-0 pt-0'">
        <div data-test="composer-controls" class="flex min-w-0 flex-1 items-center gap-2">
          <slot name="controls" />
        </div>
        <div data-test="composer-actions" class="flex shrink-0 items-center gap-1.5">
          <slot name="actions" />
        </div>
      </div>
    </div>
  </form>
</template>
