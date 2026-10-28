<script setup lang="ts">
import { ref } from "vue";
import type { BotAvatarConfig } from "@ganglion/xacpx-relay-protocol";
import { useModalA11y } from "../lib/use-modal-a11y";
import BotAvatar from "./BotAvatar.vue";

// Read-only enlarged preview of the Bot's avatar, opened from the basic settings
// form. It registers its own modal layer (useModalA11y), so Escape and mobile back
// close the preview alone instead of the Bot dialog underneath, focus returns to
// the avatar trigger on close, and the paused `static` avatar keeps the preview
// from spinning up a second frame clock.
const props = defineProps<{
  avatar?: BotAvatarConfig;
  driver?: string | null;
  name?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const dialogEl = ref<HTMLElement | null>(null);
useModalA11y(dialogEl, () => emit("close"));
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4"
         data-test="bot-avatar-quick-view-overlay"
         @click.self="emit('close')">
      <div ref="dialogEl"
           role="dialog"
           aria-modal="true"
           tabindex="-1"
           :aria-label="$t('bot.avatar.quickView')"
           class="flex flex-col items-center gap-3 rounded-2xl bg-surface p-6 text-fg shadow-float">
        <BotAvatar :avatar="props.avatar" :driver="props.driver" :name="props.name" :size="144" static />
        <p class="max-w-[12rem] truncate text-sm font-semibold">{{ props.name || $t('bot.avatar.preview.unnamed') }}</p>
        <button type="button"
                data-test="bot-avatar-quick-view-close"
                :aria-label="$t('common.close')"
                class="rounded-lg px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                @click="emit('close')">
          {{ $t("common.close") }}
        </button>
      </div>
    </div>
  </Teleport>
</template>
