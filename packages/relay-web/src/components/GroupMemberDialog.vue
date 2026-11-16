<script setup lang="ts">
import { X } from "lucide-vue-next";
import type { GroupMemberRow } from "../lib/group-members";
import { navigateBack } from "../lib/mobile-back";
import DialogShell from "./DialogShell.vue";
import GroupMemberList from "./GroupMemberList.vue";

/**
 * The desktop (from lg) surface of the Group member panel.
 *
 * It is its own component on purpose: DialogShell registers ONE modal
 * layer per mounted surface, and the mobile bottom sheet (MobileSheet)
 * registers its own. Keeping the desktop dialog separate means exactly one
 * layer is live on each layout, so Escape and the mobile back gesture close
 * this panel and nothing else.
 */
const props = defineProps<{
  rows: GroupMemberRow[];
  /** The accessible name: the Group, its member count and the disabled count. */
  label: string;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <Teleport to="body">
  <DialogShell
    panel-class="flex max-h-full w-full min-w-0 max-w-md flex-col overflow-hidden rounded-2xl"
    :label="props.label"
    test-id="group-member-dialog"
    @close="emit('close')"
  >
        <div class="flex shrink-0 items-center justify-between gap-2 px-5 py-3.5">
          <h2 class="min-w-0 truncate text-base font-semibold">{{ props.label }}</h2>
          <button
            type="button"
            data-test="group-member-close"
            :aria-label="$t('common.close')"
            class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            @click="navigateBack"
          >
            <X :size="16" />
          </button>
        </div>
        <div class="thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
          <GroupMemberList :rows="props.rows" />
        </div>
  </DialogShell>
  </Teleport>
</template>
