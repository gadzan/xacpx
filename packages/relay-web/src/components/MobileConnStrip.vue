<script lang="ts">
import type { InjectionKey, Ref } from "vue";
/** Provided by DashboardView: true once the event socket has opened in this page lifetime. */
export const CONN_EVER_OPENED: InjectionKey<Readonly<Ref<boolean>>> = Symbol("conn-ever-opened");
</script>

<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { useConnectionStore } from "../stores/connection";
import { CloudOff } from "lucide-vue-next";

// Thin connection strip that sits directly under the mobile top bar (session / bot
// views). PR4 rule: it appears only AFTER the connection has been open at least once
// in this page's lifetime, so a cold start that has not connected yet shows nothing
// rather than a false alarm. The "has been open once" memory lives in DashboardView
// (provided via CONN_EVER_OPENED, so a strip that mounts while offline still knows);
// outside the dashboard it falls back to tracking from mount. The connection store
// stays a bare online flag on purpose (the neutral everOpened state is PR5 work).
const conn = useConnectionStore();
const provided = inject(CONN_EVER_OPENED, null);
const seenLocally = ref(conn.online);
watch(() => conn.online, (online) => { if (online) seenLocally.value = true; });
const everOpened = computed(() => provided?.value || seenLocally.value);
</script>

<template>
  <div v-if="!conn.online && everOpened" data-test="conn-strip" role="status"
       class="flex shrink-0 items-center justify-center gap-1.5 bg-warn/10 px-3 py-1 text-xs text-warn lg:hidden">
    <CloudOff :size="12" class="shrink-0" />
    <span>{{ $t("connection.reconnecting") }}</span>
  </div>
</template>
