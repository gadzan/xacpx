<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { createTerminalAdapter, type TerminalAdapter } from "../lib/terminal-adapter";
import { useTerminalStore } from "../stores/terminal";

const props = defineProps<{ instanceId: string; sessionAlias: string }>();
const terminals = useTerminalStore();
const host = ref<HTMLDivElement | null>(null);
const status = ref<"idle" | "connecting" | "open" | "exited" | "error">("idle");
const errorKey = ref<string>("");

let adapter: TerminalAdapter | null = null;
let terminalId = "";
let offOutput: (() => void) | null = null;
let offExit: (() => void) | null = null;
let resizeObs: ResizeObserver | null = null;

function teardown() {
  offOutput?.(); offExit?.();
  resizeObs?.disconnect(); resizeObs = null;
  if (terminalId) terminals.close(props.instanceId, terminalId);
  adapter?.dispose(); adapter = null; terminalId = "";
}

async function start() {
  teardown();
  if (!props.sessionAlias || !host.value) { status.value = "idle"; return; }
  status.value = "connecting";
  adapter = createTerminalAdapter(host.value, {
    cols: 80, rows: 24,
    onData: (d) => { if (terminalId) terminals.input(props.instanceId, terminalId, d); },
  });
  offOutput = terminals.onOutput((id, data) => { if (id === terminalId) adapter?.write(data); });
  offExit = terminals.onExit((id, code) => { if (id === terminalId) { status.value = "exited"; errorKey.value = String(code); } });
  try {
    terminalId = await terminals.create(props.instanceId, props.sessionAlias, adapter.cols(), adapter.rows());
    status.value = "open";
    resizeObs = new ResizeObserver(() => { if (terminalId && adapter) terminals.resize(props.instanceId, terminalId, adapter.cols(), adapter.rows()); });
    if (host.value) resizeObs.observe(host.value);
  } catch (e) {
    status.value = "error";
    const msg = e instanceof Error ? e.message : "";
    errorKey.value = msg === "terminal-disabled" ? "terminal.disabled"
      : msg === "terminal-unsupported-platform" ? "terminal.unsupported"
      : msg === "instance-offline" ? "terminal.offline" : "terminal.offline";
  }
}

onMounted(() => void start());
watch(() => [props.instanceId, props.sessionAlias], () => void start());
onBeforeUnmount(teardown);
</script>

<template>
  <div class="flex h-full flex-col">
    <div v-if="!props.sessionAlias" class="p-4 text-sm text-fg-muted">{{ $t("terminal.noSession") }}</div>
    <div v-else-if="status === 'error'" class="p-4 text-sm text-fg-muted">{{ $t(errorKey) }}</div>
    <div v-else-if="status === 'exited'" class="p-4 text-sm text-fg-muted">{{ $t("terminal.exited", { code: errorKey }) }}</div>
    <div ref="host" class="min-h-0 flex-1 overflow-hidden bg-black" data-test="terminal-host"></div>
  </div>
</template>
