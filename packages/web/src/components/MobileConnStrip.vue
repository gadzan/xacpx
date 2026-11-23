<script setup lang="ts">
import { useConnectionStore } from "../stores/connection";
import { CloudOff } from "lucide-vue-next";

// Thin connection strip under the mobile top bar. Appears only AFTER the
// connection has been open at least once in this page lifetime (conn.everOpened
// from the connection store), so a cold start that has not connected yet shows
// nothing rather than a false alarm.
const conn = useConnectionStore();
</script>

<template>
  <div v-if="!conn.online && conn.everOpened" data-test="conn-strip" role="status"
       class="flex shrink-0 items-center justify-center gap-1.5 bg-warn/10 px-3 py-1 text-xs text-warn lg:hidden">
    <CloudOff :size="12" class="shrink-0" />
    <span>{{ $t("connection.reconnecting") }}</span>
  </div>
</template>
