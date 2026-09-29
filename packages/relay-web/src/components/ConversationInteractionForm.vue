<script setup lang="ts">
/**
 * Feishu-independent renderer for an open relay interaction.
 *
 * Renders whatever the hub-validated `InteractionRequestDto` asks, and reports
 * the user's decision back to the store. This is the last link of the chain
 * agent -> ACP -> core -> relay -> browser -> decision -> same turn.
 *
 * Design constraints the component enforces (or the store does, on its behalf):
 *
 *   - Answers are held until Submit, never sent per keystroke. A half-finished
 *     form is nobody else's business.
 *   - The default is shown as the CURRENT VALUE, editable, so a default can
 *     never be submitted unlooked-at.
 *   - Decline and Cancel are separate controls with separate outcomes.
 *   - All agent-supplied text renders as data: no `v-html` anywhere.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, Loader2, X } from "lucide-vue-next";
import type {
  InteractionFieldDto,
  InteractionRequestDto,
  InteractionValueDto,
} from "@ganglion/xacpx-relay-protocol";

const props = defineProps<{
  request: InteractionRequestDto;
  /**
   * What the user has entered so far.
   *
   * Passed in rather than read off `request` on purpose: the request is the
   * hub-validated payload and must stay immutable, while answers are local
   * state that changes on every keystroke. Reading them off the request would
   * mean either mutating a protocol object or looking at a field that is not
   * there.
   */
  answers: Record<string, InteractionValueDto>;
  submitting: boolean;
  errorCode: string | null;
  outcome: "accepted" | "declined" | "cancelled" | "withdrawn" | null;
}>();

const emit = defineEmits<{
  (e: 'answer', key: string, value: InteractionValueDto): void;
  (e: 'submit'): void;
  (e: 'decline'): void;
  (e: 'cancel'): void;
  (e: 'dismiss'): void;
}>();

const { t } = useI18n();

const fields = computed<readonly InteractionFieldDto[]>(() => props.request.elicitation?.fields ?? []);

const requiredMissing = computed<readonly InteractionFieldDto[]>(() =>
  fields.value.filter((field) => field.required && props.answers[field.key] === undefined),
);

const messageLines = computed<readonly string[]>(() => {
  const message = props.request.elicitation?.message ?? '';
  return message.length === 0 ? [] : message.split('\n');
});

/** The `name` a field's control uses, matching the store's answer keys. */
function controlName(field: InteractionFieldDto): string {
  return `f${field.key.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16)}`;
}

/**
 * Typed coercion for the field the user is editing.
 *
 * Each field kind has a wire type core will validate against, so the renderer
 * MUST emit that type: a number field answered as a string reaches core as a
 * string and is rejected, and the transport is terminal — the hub has already
 * resolved the interaction by then, so the user cannot correct it. Coercing here
 * is what makes an invalid edit visible while the form is still open.
 */
function coerce(
  field: InteractionFieldDto,
  raw: string,
): { ok: true; value: InteractionValueDto } | { ok: false } {
  const trimmed = raw.trim();
  if (field.kind === "number") {
    if (trimmed === "") return { ok: true, value: undefined as never };
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return { ok: false };
    // integer constraint is the field's own, and it is enforced here rather than
    // deferred: a fractional answer to an integer field is rejected later, after
    // the form has already closed.
    if (field.integer === true && !Number.isInteger(parsed)) return { ok: false };
    return { ok: true, value: parsed };
  }
  if (field.kind === "text") {
    if (field.format === "date" && trimmed !== "" && Number.isNaN(Date.parse(trimmed))) {
      return { ok: false };
    }
    if (field.format === "email" && trimmed !== "" && !/^[^@\s]+@[^@\s]+$/.test(trimmed)) {
      return { ok: false };
    }
    return { ok: true, value: raw };
  }
  return { ok: true, value: raw };
}

/**
 * Per-field problems the renderer can detect BEFORE Submit.
 *
 * Terminal transport is why this exists locally. A hub that validated shape only
 * resolved the interaction; core then rejected the answer set, and the form was
 * already gone — an ordinary typo became an unrecoverable failure. Checking the
 * field's own bounds turns it into a message the user can act on.
 */
function fieldProblems(field: InteractionFieldDto, answer: InteractionValueDto | undefined): string[] {
  const problems: string[] = [];
  const present = answer !== undefined && !(typeof answer === "string" && answer === "");
  if (!present) {
    if (field.required) problems.push("required");
    return problems;
  }
  if (field.kind === "text") {
    const text = String(answer);
    if (field.minLength !== undefined && text.length < field.minLength) problems.push("minLength");
    if (field.maxLength !== undefined && text.length > field.maxLength) problems.push("maxLength");
    if (field.pattern !== undefined) {
      // Compiled only here, from the hub-validated field, and a malformed
      // pattern is IGNORED rather than surfaced: core still validates, and
      // treating a bad pattern as a failed answer would block a form the user
      // filled correctly.
      try {
        if (!new RegExp(field.pattern).test(text)) problems.push("pattern");
      } catch {
        // Unusable pattern: core is the authority.
      }
    }
  }
  if (field.kind === "number") {
    const value = Number(answer);
    if (field.minimum !== undefined && value < field.minimum) problems.push("minimum");
    if (field.maximum !== undefined && value > field.maximum) problems.push("maximum");
    if (field.integer === true && !Number.isInteger(value)) problems.push("integer");
  }
  if (field.kind === "multi-select") {
    const values = Array.isArray(answer) ? answer : [];
    if (field.minItems !== undefined && values.length < field.minItems) problems.push("minItems");
    if (field.maxItems !== undefined && values.length > field.maxItems) problems.push("maxItems");
  }
  return problems;
}

/** Every field that would be rejected, so Submit can be blocked with a reason. */
const invalidFields = computed<readonly { field: InteractionFieldDto; problems: string[] }[]>(() =>
  fields.value
    .map((field) => ({ field, problems: fieldProblems(field, props.answers[field.key]) }))
    .filter((entry) => entry.problems.length > 0),
);

const canSubmit = computed<boolean>(() => invalidFields.value.length === 0);

/** Multi-select selections are a set, so toggling an option adds or removes it. */
function onMultiToggle(field: InteractionFieldDto, optionValue: string): void {
  const current = props.answers[field.key];
  const selected = Array.isArray(current) ? current : [];
  emit('answer', field.key, selected.includes(optionValue)
    ? selected.filter((v) => v !== optionValue)
    : [...selected, optionValue]);
}

function onNumberInput(field: InteractionFieldDto, event: Event): void {
  const target = event.target as HTMLInputElement | null;
  if (!target) return;
  const result = coerce(field, target.value);
  if (result.ok) emit('answer', field.key, result.value);
}

function onTextInput(field: InteractionFieldDto, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
  if (!target) return;
  const result = coerce(field, target.value);
  if (result.ok) emit('answer', field.key, result.value);
}

function onSelect(field: InteractionFieldDto, event: Event): void {
  const target = event.target as HTMLSelectElement | null;
  if (!target) return;
  emit('answer', field.key, target.value);
}
</script>

<template>
  <div
    data-test="interaction-form"
    class="w-full rounded-lg border border-warning/40 bg-warning/5 p-3 space-y-3"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
          <AlertTriangle :size="12" />
          <span>{{ t('bot.interaction.title') }}</span>
        </div>
        <!-- Agent-controlled text, rendered as data. No v-html: the point is that
          nothing the agent wrote can become markup here. -->
        <div
          v-for="(line, index) in messageLines"
          :key="index"
          class="whitespace-pre-wrap text-xs text-fg"
        >{{ line }}</div>
      </div>
      <button
        v-if="outcome"
        type="button"
        data-test="interaction-dismiss"
        class="shrink-0 rounded p-1 text-fg-muted hover:bg-surface hover:text-fg transition-colors"
        :aria-label="t('bot.interaction.dismiss')"
        @click="emit('dismiss')"
      >
        <X :size="13" />
      </button>
    </div>

    <!-- Terminal notice. A hub-side close is `withdrawn`, never `cancelled`: the
      user did not choose it and the UI must not claim they did. -->
    <div
      v-if="outcome"
      data-test="interaction-outcome"
      class="text-xs font-medium"
      :class="outcome === 'accepted' ? 'text-ok' : outcome === 'declined' ? 'text-warning' : 'text-fg-muted'"
    >
      {{ outcome === 'accepted' ? t('bot.interaction.accepted')
        : outcome === 'declined' ? t('bot.interaction.declined')
        : outcome === 'cancelled' ? t('bot.interaction.cancelled')
        : t('bot.interaction.withdrawn') }}
    </div>

    <template v-else>
      <div
        v-for="field in fields"
        :key="field.key"
        class="space-y-1"
        :data-test="`interaction-field-${field.key}`"
      >
        <label class="flex items-baseline gap-1.5 text-xs font-medium text-fg" :for="controlName(field)">
          <span>{{ field.title }}</span>
          <span v-if="!field.required" class="text-[10.5px] font-normal text-fg-muted">
            ({{ t('bot.interaction.optional') }})
          </span>
        </label>
        <div v-if="field.description" class="text-[11px] leading-snug text-fg-muted">{{ field.description }}</div>

        <!-- Boolean: two explicit options, not a checkbox, so the user answers the
          question rather than toggling a state. -->
        <div v-if="field.kind === 'boolean'" class="flex gap-2">
          <button
            v-for="option in [true, false]"
            :key="String(option)"
            type="button"
            class="rounded border border-border px-3 py-1 text-xs transition-colors"
            :class="String(answers[field.key]) === String(option)
              ? 'border-accent bg-accent/10 text-accent'
              : 'text-fg hover:bg-surface'"
            @click="emit('answer', field.key, option)"
          >
            {{ option ? t('bot.interaction.yes') : t('bot.interaction.no') }}
          </button>
        </div>

        <!-- Select: the option VALUE is the answer, so the label can be anything
          the agent wrote. The current selection is always visible. -->
        <select
          v-else-if="field.kind === 'single-select'"
          :id="controlName(field)"
          :data-test="`interaction-select-${field.key}`"
          class="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-fg"
          :value="String(answers[field.key] ?? '')"
          @change="onSelect(field, $event)"
        >
          <option value="" disabled>{{ t('bot.interaction.choose') }}</option>
          <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <!-- Multi-select: the answer is a string[] of option VALUES, so the
          renderer must produce an array. A single value here would be rejected by
          core after the form had already closed. -->
        <div v-else-if="field.kind === 'multi-select'" class="space-y-1">
          <button
            v-for="option in field.options ?? []"
            :key="option.value"
            type="button"
            :data-test="`interaction-multi-${option.value}`"
            class="mr-1 mb-1 rounded border px-2 py-1 text-xs transition-colors"
            :class="(Array.isArray(answers[field.key]) ? answers[field.key] as string[] : []).includes(option.value)
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border text-fg hover:bg-surface'"
            @click="onMultiToggle(field, option.value)"
          >
            {{ option.label }}
          </button>
        </div>

        <!-- Number: `inputmode` and `type=number` so a numeric keyboard appears,
          but the value is COERCED in the handler — `type=number` alone still hands
          back a string on some platforms. -->
        <input
          v-else-if="field.kind === 'number'"
          :id="controlName(field)"
          :data-test="`interaction-input-${field.key}`"
          type="number"
          inputmode="decimal"
          class="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-fg"
          :placeholder="field.title"
          :value="String(answers[field.key] ?? field.defaultValue ?? '')"
          @input="onNumberInput(field, $event)"
        />

        <!-- Everything else is free text; the answer is sent verbatim for core to
          validate, because the renderer is not the authority on schema rules. -->
        <input
          v-else
          :id="controlName(field)"
          :data-test="`interaction-input-${field.key}`"
          type="text"
          class="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-fg"
          :placeholder="field.title"
          :value="String(answers[field.key] ?? field.defaultValue ?? '')"
          @input="onTextInput(field, $event)"
        />
      </div>

      <!-- Field-level problems the renderer can see. Surfaced BEFORE Submit, while
        the form is still open: the interaction resolves on submit, so an answer
        core rejects afterwards is one the user cannot correct. -->
      <div v-if="invalidFields.length > 0" data-test="interaction-invalid" class="text-[11px] text-danger">
        <div v-for="entry in invalidFields" :key="entry.field.key">
          {{ t('bot.interaction.fieldInvalid', {
            title: entry.field.title,
            problem: entry.problems.join(', '),
          }) }}
        </div>
      </div>

      <div v-if="requiredMissing.length > 0" class="text-[11px] text-warning">
        {{ t('bot.interaction.requiredMissing', { fields: requiredMissing.map((f) => f.title).join(', ') }) }}
      </div>

      <div v-if="errorCode" data-test="interaction-error" class="text-[11px] font-medium text-danger">
        {{ errorCode === 'interactionGone' ? t('bot.interaction.errorGone')
          : errorCode === 'connectorOutdated' ? t('bot.interaction.errorOutdated')
          : t('bot.interaction.errorFailed') }}
      </div>

      <div class="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          data-test="interaction-submit"
          class="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg transition-opacity disabled:opacity-50"
          :disabled="submitting || requiredMissing.length > 0 || !canSubmit"
          @click="emit('submit')"
        >
          <Loader2 v-if="submitting" :size="12" class="animate-spin" />
          <Check v-else :size="12" />
          <span>{{ t('bot.interaction.submit') }}</span>
        </button>
        <button
          type="button"
          data-test="interaction-decline"
          class="rounded border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20 disabled:opacity-50"
          :disabled="submitting"
          @click="emit('decline')"
        >
          {{ t('bot.interaction.decline') }}
        </button>
        <button
          type="button"
          data-test="interaction-cancel"
          class="rounded border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface disabled:opacity-50"
          :disabled="submitting"
          @click="emit('cancel')"
        >
          {{ t('bot.interaction.cancel') }}
        </button>
      </div>
    </template>
  </div>
</template>
