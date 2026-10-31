<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2 } from "lucide-vue-next";

/**
 * The "who is working" row, at the top of the Group chat.
 *
 * It names the members that currently hold a turn, so the reader knows the
 * Group is busy without opening the transcript. When nobody is working the
 * row renders nothing at all — an idle Group has no status line to show.
 */
const props = defineProps<{
  /** The members that currently hold a turn, in the order they took them. */
  members: { botId: string; name: string }[];
}>();

const { t, locale } = useI18n();

const text = computed(() => {
  if (props.members.length === 0) return "";
  const names = new Intl.ListFormat(locale.value, { type: "conjunction" })
    .format(props.members.map((member) => member.name));
  return t("group.panel.working", { names });
});
</script>

<template>
  <div
    v-if="text"
    data-test="group-working-row"
    class="flex min-h-8 items-center gap-1.5 bg-surface px-3 py-1.5 text-xs text-fg-muted lg:px-5"
  >
    <Loader2 :size="12" class="shrink-0 animate-spin text-accent" aria-hidden="true" />
    <span data-test="group-working-text" class="min-w-0 truncate">{{ text }}</span>
  </div>
</template>
