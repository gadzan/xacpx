<script setup lang="ts">
import { useConnectionStore } from "../stores/connection";
const conn = useConnectionStore();
</script>

<template>
  <div
    data-test="conn-badge"
    class="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs"
    :class="conn.online ? 'text-run' : 'text-danger'"
    :title="conn.online ? $t('connection.online') : $t('connection.reconnecting')"
  >
    <span
      class="h-2 w-2 rounded-full"
      :class="conn.online ? 'bg-run' : 'bg-danger'"
      aria-hidden="true"
    />
    <span>{{ conn.online ? $t("connection.online") : $t("connection.reconnecting") }}</span>
  </div>
</template>
