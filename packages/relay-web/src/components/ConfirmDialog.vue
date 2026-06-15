<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { AlertTriangle } from "lucide-vue-next";
import { settleConfirm, useConfirmState } from "../lib/use-confirm";

// Global host for confirm({...}) — mounted once near the app root. Teleports to body so
// it overlays everything (including other dialogs). Esc cancels, Enter confirms.
const pending = useConfirmState();

function onKey(e: KeyboardEvent): void {
  if (!pending.value) return;
  if (e.key === "Escape") { e.preventDefault(); settleConfirm(false); }
  else if (e.key === "Enter") { e.preventDefault(); settleConfirm(true); }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div v-if="pending" class="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" @click="settleConfirm(false)" />
      <div role="alertdialog" aria-modal="true" data-test="confirm-dialog"
           :aria-label="pending.title"
           class="relative w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-e3">
        <div class="flex items-start gap-3">
          <div class="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
               :class="pending.tone === 'default' ? 'bg-accent/10 text-accent' : 'bg-danger/10 text-danger'">
            <AlertTriangle :size="18" />
          </div>
          <div class="min-w-0 flex-1 pt-0.5">
            <h2 class="text-[15px] font-semibold text-fg">{{ pending.title }}</h2>
            <p v-if="pending.message" class="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-fg-muted">{{ pending.message }}</p>
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <button data-test="confirm-cancel" type="button"
                  class="rounded-lg px-3 py-1.5 text-[13px] font-medium text-fg-muted transition-colors hover:bg-fg/5"
                  @click="settleConfirm(false)">{{ pending.cancelLabel ?? "Cancel" }}</button>
          <button data-test="confirm-ok" type="button"
                  class="rounded-lg px-3 py-1.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
                  :class="pending.tone === 'default' ? 'bg-accent' : 'bg-danger'"
                  @click="settleConfirm(true)">{{ pending.confirmLabel ?? "Confirm" }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
