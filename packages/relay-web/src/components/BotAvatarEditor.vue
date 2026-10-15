<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronDown, RotateCcw, Sparkles } from "lucide-vue-next";
import {
  BOT_AVATAR_SHAPES,
  BOT_AVATAR_COLORS,
  BOT_AVATAR_EXPRESSIONS,
  sameBotAvatar,
  type BotAvatarConfig,
  type CharacterAvatarConfig,
  type ExpressionId,
} from "@ganglion/xacpx-relay-protocol";
import type { BotAvatarState } from "../lib/bot-avatar-state";
import { AVATAR_PALETTE } from "../lib/bot-avatar/catalog";
import BotAvatar from "./BotAvatar.vue";

const props = withDefaults(defineProps<{
  modelValue?: BotAvatarConfig;
  driver?: string | null;
  name?: string;
  previewState?: BotAvatarState;
}>(), { previewState: "idle" });
const emit = defineEmits<{
  "update:modelValue": [value: BotAvatarConfig | undefined];
  "update:previewState": [value: BotAvatarState];
}>();
const { t } = useI18n();
const previewState = computed(() => props.previewState);
const previewRevision = ref(0);
function preview(state: BotAvatarState): void {
  emit("update:previewState", state);
  previewRevision.value++;
}
const expandedExpressions = ref(false);
const previewStates = ["idle", "working", "streaming", "waiting", "completed"] as const;
const commonExpressions: ExpressionId[] = ["neutre", "curieux", "attentif", "heureux", "fier", "somnolent"];
const expressions = computed(() => expandedExpressions.value
  ? [...commonExpressions, ...BOT_AVATAR_EXPRESSIONS.filter((id) => !commonExpressions.includes(id))]
  : commonExpressions);

function character(overrides: Partial<CharacterAvatarConfig> = {}): CharacterAvatarConfig {
  return { version: 1, kind: "character", shape: "cercle", color: "bleu", expression: "neutre", motion: "auto", ...overrides };
}
const selectedCharacter = computed(() => props.modelValue?.kind === "character" ? props.modelValue : character());
const presets = [
  { id: "classic", avatar: character() },
  { id: "curious", avatar: character({ shape: "galet", color: "turquoise", expression: "curieux" }) },
  { id: "focused", avatar: character({ shape: "squircle", color: "violet", expression: "attentif" }) },
  { id: "sunny", avatar: character({ shape: "nuage", color: "ambre", expression: "heureux" }) },
  { id: "bold", avatar: character({ shape: "hexagone", color: "rouge", expression: "fier" }) },
  { id: "gentle", avatar: character({ shape: "goutte", color: "creme", expression: "timide" }) },
];
const choiceClass = (selected: boolean) => selected
  ? "bg-accent-soft text-accent ring-1 ring-accent"
  : "bg-surface-2 text-fg-muted hover:bg-raised hover:text-fg";
const hasCharacter = computed(() => props.modelValue?.kind === "character");
function updateCharacter(change: Partial<CharacterAvatarConfig>): void {
  emit("update:modelValue", { ...selectedCharacter.value, ...change });
}
</script>

<template>
  <div class="grid min-w-0 grid-cols-1 gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
 <section :aria-label="t('bot.avatar.preview.title')" class="min-w-0 self-start rounded-2xl bg-bg p-4 md:sticky md:top-0">
      <div class="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        <Sparkles :size="14" /> {{ t('bot.avatar.preview.title') }}
      </div>
      <div class="flex flex-col items-center gap-3 py-5">
 <div class="grid h-36 w-36 place-items-center rounded-3xl bg-surface">
          <BotAvatar :avatar="modelValue" :driver="driver" :name="name" :size="120" :state="previewState"
                     :activity-key="`avatar-editor-preview:${previewRevision}`" follow preview />
        </div>
        <div class="max-w-full text-center">
          <p class="break-words text-sm font-semibold text-fg">{{ name || t('bot.avatar.preview.unnamed') }}</p>
          <p class="mt-1 text-xs text-fg-muted" aria-live="polite">{{ t(`bot.avatar.states.${previewState}`) }}</p>
        </div>
      </div>
      <div class="flex flex-wrap justify-center gap-1.5" role="group" :aria-label="t('bot.avatar.preview.states')">
        <button v-for="state in previewStates" :key="state" type="button" :data-test="`avatar-preview-${state}`"
                :aria-pressed="previewState === state" class="rounded-md px-2 py-1 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-accent"
                :class="choiceClass(previewState === state)" @click="preview(state)">
          {{ t(`bot.avatar.states.${state}`) }}
        </button>
      </div>
      <p class="mt-2 text-center text-[11px] leading-relaxed text-fg-muted">{{ t('bot.avatar.preview.hint') }}</p>
 <div class="mt-4 pt-3">
        <p class="text-xs font-medium text-fg-muted">{{ t('bot.avatar.preview.sizes') }}</p>
        <div class="mt-3 flex items-end justify-center gap-5">
          <div v-for="size in [20, 28, 36]" :key="size" class="flex flex-col items-center gap-2">
            <BotAvatar :avatar="modelValue" :driver="driver" :name="name" :size="size" static />
            <span class="text-[10px] tabular-nums text-fg-muted">{{ size }} px</span>
          </div>
        </div>
      </div>
    </section>

    <div class="min-w-0 space-y-5">
 <section v-if="modelValue?.kind === 'text'" class="rounded-xl bg-raised p-3" :aria-label="t('bot.avatar.text.title')">
        <h3 class="text-xs font-semibold">{{ t('bot.avatar.text.title') }}</h3>
        <p class="mt-1 text-xs leading-relaxed text-fg-muted">{{ t('bot.avatar.text.notice') }}</p>
 <p data-test="avatar-retained-text" class="mt-3 whitespace-pre-wrap break-all rounded-lg bg-bg p-2 text-xs text-fg">{{ modelValue.value }}</p>
 <button type="button" data-test="avatar-replace-text" class="mt-3 rounded-lg px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent-soft"
                @click="emit('update:modelValue', character())">{{ t('bot.avatar.text.replace') }}</button>
      </section>
 <p v-else-if="!modelValue" class="rounded-xl bg-raised p-3 text-xs leading-relaxed text-fg-muted">{{ t('bot.avatar.defaultNotice') }}</p>

      <section :aria-label="t('bot.avatar.presets.title')">
        <h3 class="mb-2 text-xs font-semibold">{{ t('bot.avatar.presets.title') }}</h3>
        <div class="grid grid-cols-3 gap-2">
          <button v-for="preset in presets" :key="preset.id" type="button" :data-test="`avatar-preset-${preset.id}`"
                  :aria-pressed="sameBotAvatar(modelValue, preset.avatar)" class="flex min-w-0 flex-col items-center gap-1.5 rounded-xl p-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent"
                  :class="choiceClass(sameBotAvatar(modelValue, preset.avatar))" @click="emit('update:modelValue', { ...preset.avatar })">
            <BotAvatar :avatar="preset.avatar" :size="36" static />
            <span class="w-full break-words text-center text-[11px]">{{ t(`bot.avatar.presets.${preset.id}`) }}</span>
          </button>
        </div>
      </section>

      <section :aria-label="t('bot.avatar.shape')">
        <h3 class="mb-2 text-xs font-semibold">{{ t('bot.avatar.shape') }}</h3>
        <div class="grid grid-cols-4 gap-2">
          <button v-for="shape in BOT_AVATAR_SHAPES" :key="shape" type="button" :data-test="`avatar-shape-${shape}`"
                  :aria-pressed="hasCharacter && selectedCharacter.shape === shape" class="flex min-w-0 flex-col items-center gap-1.5 rounded-lg p-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent"
                  :class="choiceClass(hasCharacter && selectedCharacter.shape === shape)" @click="updateCharacter({ shape })">
            <BotAvatar :avatar="{ ...selectedCharacter, shape }" :size="30" static />
            <span class="w-full break-words text-center text-[10px]">{{ t(`bot.avatar.shapes.${shape}`) }}</span>
          </button>
        </div>
      </section>

      <section :aria-label="t('bot.avatar.color')">
        <h3 class="mb-2 text-xs font-semibold">{{ t('bot.avatar.color') }}</h3>
        <div class="grid grid-cols-4 gap-2 sm:grid-cols-6">
          <button v-for="color in BOT_AVATAR_COLORS" :key="color" type="button" :data-test="`avatar-color-${color}`"
                  :aria-pressed="hasCharacter && selectedCharacter.color === color" class="flex min-w-0 flex-col items-center gap-1.5 rounded-lg px-1 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent"
                  :class="choiceClass(hasCharacter && selectedCharacter.color === color)" @click="updateCharacter({ color })">
            <span class="grid h-6 w-6 place-items-center rounded-full ring-1 ring-black/20" :style="{ backgroundColor: AVATAR_PALETTE[color] }">
              <Check v-if="hasCharacter && selectedCharacter.color === color" :size="14" class="rounded-full bg-surface text-fg" aria-hidden="true" />
            </span>
            <span class="w-full break-words text-center text-[10px]">{{ t(`bot.avatar.colors.${color}`) }}</span>
          </button>
        </div>
      </section>

      <section :aria-label="t('bot.avatar.expression')">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-xs font-semibold">{{ t('bot.avatar.expression') }}</h3>
          <button type="button" data-test="avatar-expressions-toggle" :aria-expanded="expandedExpressions" aria-controls="avatar-expression-options"
                  class="flex items-center gap-1 text-[11px] text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent" @click="expandedExpressions = !expandedExpressions">
            {{ t(expandedExpressions ? 'bot.avatar.commonExpressions' : 'bot.avatar.allExpressions') }}
            <ChevronDown :size="12" :class="{ 'rotate-180': expandedExpressions }" />
          </button>
        </div>
        <div id="avatar-expression-options" class="grid grid-cols-3 gap-2 sm:grid-cols-4">
          <button v-for="expression in expressions" :key="expression" type="button" :data-test="`avatar-expression-${expression}`"
                  :aria-pressed="hasCharacter && selectedCharacter.expression === expression" class="flex min-w-0 flex-col items-center gap-1 rounded-lg p-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent"
                  :class="choiceClass(hasCharacter && selectedCharacter.expression === expression)" @click="updateCharacter({ expression })">
            <BotAvatar :avatar="{ ...selectedCharacter, expression }" :size="28" static />
            <span class="w-full break-words text-center text-[10px]">{{ t(`bot.avatar.expressions.${expression}`) }}</span>
          </button>
        </div>
        <p v-if="hasCharacter && !expressions.includes(selectedCharacter.expression)" class="mt-2 text-[11px] text-fg-muted">
          {{ t('bot.avatar.selectedExpression', { expression: t(`bot.avatar.expressions.${selectedCharacter.expression}`) }) }}
        </p>
      </section>

 <div class="rounded-xl p-3">
        <label class="flex cursor-pointer items-center gap-2 text-xs font-medium">
          <input type="checkbox" data-test="avatar-motion" :checked="hasCharacter && selectedCharacter.motion === 'auto'"
                 class="rounded border-border text-accent focus:ring-accent" @change="updateCharacter({ motion: ($event.target as HTMLInputElement).checked ? 'auto' : 'off' })" />
          {{ t('bot.avatar.motion.title') }}
        </label>
        <p class="mt-1.5 text-[11px] leading-relaxed text-fg-muted">{{ t('bot.avatar.motion.hint') }}</p>
      </div>
      <button type="button" data-test="avatar-reset" :disabled="!modelValue"
              class="flex items-center gap-1.5 rounded-lg px-1 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
              @click="emit('update:modelValue', undefined)">
        <RotateCcw :size="13" /> {{ t('bot.avatar.restoreDefault') }}
      </button>
    </div>
  </div>
</template>
