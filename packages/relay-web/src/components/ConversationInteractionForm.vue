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

function onTextInput(field: InteractionFieldDto, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
  if (!target) return;
  emit('answer', field.key, target.value);
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

        <!-- Everything else is free text; the answer is sent verbatim for core to
          validate, because the renderer is not the authority on schema rules. -->
        <input
          v-else
          :id="controlName(field)"
          :data-test="`interaction-input-${field.key}`"
          type="text"
          class="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-fg"
          :placeholder="field.title"
          :value="String(answers[field.key] ?? '')"
          @input="onTextInput(field, $event)"
        />
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
          :disabled="submitting || requiredMissing.length > 0"
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
