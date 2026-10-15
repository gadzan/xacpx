<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useConnectionStore, connectionStatus } from "../stores/connection";

const conn = useConnectionStore();

// The badge escalates a drop by age, so it needs a clock that ticks while
// offline. One shared interval, started on the first drop and cleared on
// reconnect or unmount.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

function stopClock(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

watch(
  () => conn.online,
  (online) => {
    stopClock();
    if (online) return;
    now.value = Date.now();
    timer = setInterval(() => { now.value = Date.now(); }, 1000);
  },
  { immediate: true },
);
onUnmounted(stopClock);

// One descriptor per state: the dot fill, the label color, and the i18n key for
// the text. "connecting" gets its own key; every offline state past the first
// reads as a reconnect whose color escalates with age.
const appearance = computed(() => {
  const status = connectionStatus({
    online: conn.online,
    everOpened: conn.everOpened,
    offlineMs: conn.offlineSince === null ? null : Math.max(0, now.value - conn.offlineSince),
  });
  switch (status) {
    case "online":
      return { status, dot: "bg-run-bright", text: "text-run", key: "connection.online" };
    case "degraded":
      return { status, dot: "bg-warn", text: "text-warn", key: "connection.reconnecting" };
    case "lost":
      return { status, dot: "bg-danger", text: "text-danger", key: "connection.reconnecting" };
    default:
      return {
        status,
        dot: "bg-fg-muted",
        text: "text-fg-muted",
        key: status === "connecting" ? "connection.connecting" : "connection.reconnecting",
      };
  }
});
</script>

<template>
  <div
    data-test="conn-badge"
    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs"
    :class="appearance.text"
    :title="$t(appearance.key)"
  >
    <span class="h-2 w-2 rounded-full" :class="appearance.dot" aria-hidden="true" />
    <span>{{ $t(appearance.key) }}</span>
  </div>
</template>
