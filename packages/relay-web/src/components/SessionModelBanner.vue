<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle } from "lucide-vue-next";
import { useSessionControlsStore } from "../stores/session-controls";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { isAuthShapedModelError } from "../lib/adapter-auth-error";

// Global, viewport-anchored diagnostic for the model-control read path.
//
// This used to live inline in PromptInput, where the composer stack's negative
// margins cut it off and long bridge errors scrolled inside a cramped box. It is
// now teleported to <body> like ToastHost so no ancestor layout can clip it.
// Only automatic load/refresh failures land here; an explicit switch failure
// stays on the standard error toast so the user never sees two prompts for one
// action.
const controls = useSessionControlsStore();
const chat = useChatStore();
const instances = useInstancesStore();
const { t } = useI18n();
const message = computed(() => {
  const detail = controls.modelError;
  if (!isAuthShapedModelError(detail)) return t("chat.modelControlFailed", { detail });
  const row = chat.instanceId && chat.sessionAlias
    ? instances.findSessionRow(chat.instanceId, chat.sessionAlias)
    : undefined;
  const agent = row?.agent?.trim() ? row.agent : t("session.thisAgent");
  return `${t("session.authHint", { agent })}\n${detail}`;
});
const visible = computed(
  () => controls.modelError !== "" && controls.modelErrorSource === "load",
);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      data-test="model-banner"
      role="status"
      aria-live="polite"
      class="fixed left-1/2 top-16 z-[55] flex w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-danger shadow-float"
    >
      <AlertCircle :size="16" class="mt-0.5 shrink-0" aria-hidden="true" />
      <span class="min-h-0 min-w-0 flex-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{{ message }}</span>
      <button
        data-test="model-banner-dismiss"
        class="shrink-0 leading-none text-danger/80 hover:text-danger"
        :aria-label="$t('common.dismiss')"
        @click="controls.dismissModelError()"
      >×</button>
    </div>
  </Teleport>
</template>
