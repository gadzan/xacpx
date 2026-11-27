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
      return { status, dot: "bg-danger", text: "text-danger-text", key: "connection.reconnecting" };
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
  <!-- Online is the steady state, so the desktop global bar shows the dot alone. The state
       stays in `title` and in the accessible name (`role="img"` + `aria-label` carries the
       same string the visible label shows), so hiding the label costs no information. Every
       other state keeps its text at every width, and < lg keeps the text too: the mobile
       chrome is unchanged. -->
  <div
    data-test="conn-badge"
    role="img"
    class="inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-xs"
    :class="[
      appearance.text,
      appearance.status === 'online'
        ? ''
        : 'border border-current/25 bg-fg/[0.04] pl-2 dark:bg-white/[0.05]',
    ]"
    :title="$t(appearance.key)"
    :aria-label="$t(appearance.key)"
  >
    <!-- A status light, not a gumball: a 6px core with a translucent halo reads as
         "steady" at a glance, and offline states grow a hairline capsule instead. -->
    <span
      class="h-1.5 w-1.5 rounded-full"
      :class="[appearance.dot, appearance.status === 'online' ? 'ring-[3px] ring-run/20' : '']"
      aria-hidden="true"
    />
    <span :class="appearance.status === 'online' ? 'lg:hidden' : ''">{{ $t(appearance.key) }}</span>
  </div>
</template>
