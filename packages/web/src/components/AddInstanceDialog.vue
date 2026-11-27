<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { Check, Copy, Loader2 } from "lucide-vue-next";
import { api } from "../api/client";
import { useInstancesStore } from "../stores/instances";
import DialogShell from "./DialogShell.vue";
import UiButton from "./UiButton.vue";
import { navigateBack } from "../lib/mobile-back";

/**
 * Add an instance in three steps: name the host, copy the one-time pairing
 * command, wait for the instance to show up connected.
 *
 * The relay broadcasts `instance-status` account-wide, so a newly paired
 * instance is first proven to exist by that event. The instances store
 * re-lists on an unknown instance id, which is what lets step 3 resolve
 * without a refresh.
 */

const emit = defineEmits<{ close: [] }>();

const instancesStore = useInstancesStore();

type Step = 1 | 2 | 3;
const step = ref<Step>(1);
const name = ref("");
const token = ref("");
const command = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const copied = ref(false);
const timedOut = ref(false);

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollDeadline = 0;

function relayWsUrl(): string {
  if (typeof location === "undefined") return "<relay-ws-url>";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
}

function buildCommand(): string {
  return `xacpx channel add relay --url ${relayWsUrl()} --token ${token.value}`;
}

async function copyCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(command.value);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = command.value;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* give up silently */
    }
    document.body.removeChild(ta);
  }
  copied.value = true;
}

async function generateToken(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const r = await api.post<{ token: string }>("/api/instances/pairing-token", { name: name.value.trim() });
    token.value = r.token;
    command.value = buildCommand();
    step.value = 2;
    void copyCommand();
    startPolling();
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

/** The instance the pairing token was minted for shows up in the list once it
 *  connects. Matching on the name we asked for is the only link the client has
 *  between the two: the pairing token itself carries the instance id. */
const connectedInstance = computed(() => {
  const wanted = name.value.trim();
  if (!wanted) return undefined;
  return instancesStore.instances.find((inst) => inst.name === wanted && inst.online);
});

function startPolling(): void {
  stopPolling();
  pollDeadline = Date.now() + POLL_TIMEOUT_MS;
  pollTimer = setInterval(() => {
    void instancesStore.loadInstances().catch(() => {});
    if (connectedInstance.value) {
      step.value = 3;
      stopPolling();
      return;
    }
    if (Date.now() >= pollDeadline) {
      timedOut.value = true;
      stopPolling();
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

onBeforeUnmount(stopPolling);

function close(): void {
  stopPolling();
  emit("close");
}
</script>

<template>
  <DialogShell
    panel-class="w-full max-w-md rounded-2xl p-5"
    labelledby="add-instance-title"
    test-id="add-instance-dialog"
    @close="emit('close')"
  >
      <h3 id="add-instance-title" class="text-base font-semibold text-fg">{{ $t("settings.addInstance") }}</h3>

      <!-- Step 1: name -->
      <div v-if="step === 1" class="mt-4">
        <p class="text-sm text-fg-muted">{{ $t("settings.addInstanceStepName") }}</p>
        <input
          v-model="name"
          type="text"
          data-test="add-instance-name"
          :placeholder="$t('settings.instanceNamePlaceholder')"
          class="mt-3 w-full rounded-2xl ui-well px-3 py-2 text-base text-fg outline-none placeholder:text-fg-muted focus-visible:ring-2 focus-visible:ring-accent"
          @keydown.enter.prevent="generateToken"
        />
        <p v-if="error" data-test="add-instance-error" class="mt-2 text-xs text-danger-text">{{ error }}</p>
        <div class="mt-4 flex items-center justify-end gap-2">
          <UiButton variant="ghost" @click="navigateBack">
            {{ $t("common.cancel") }}
          </UiButton>
          <UiButton data-test="add-instance-next" :disabled="busy || !name.trim()" @click="generateToken">
            <Loader2 v-if="busy" :size="14" class="animate-spin motion-reduce:animate-none" />
            <span v-else>{{ $t("common.next") }}</span>
          </UiButton>
        </div>
      </div>

      <!-- Step 2: copy the command, wait for the connection -->
      <div v-else-if="step === 2" class="mt-4">
        <p class="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 :size="14" class="animate-spin motion-reduce:animate-none" />
          {{ $t("settings.addInstanceWaiting") }}
        </p>
        <div class="mt-3 flex items-start gap-2">
          <code class="min-w-0 flex-1 break-all rounded-2xl ui-well p-3 text-xs text-fg" data-test="add-instance-command">
            {{ command }}
          </code>
          <button
            type="button"
            data-test="add-instance-copy"
            :aria-label="$t('settings.copyCommand')"
            :title="$t('settings.copyCommand')"
            class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl ui-well text-fg transition-colors hover:bg-raised"
            @click="copyCommand"
          >
            <Check v-if="copied" :size="16" class="text-run" />
            <Copy v-else :size="16" />
          </button>
        </div>
        <p v-if="timedOut" data-test="add-instance-timeout" class="mt-3 text-xs text-fg-muted">
          {{ $t("settings.addInstanceNotYet") }}
        </p>
        <div class="mt-4 flex items-center justify-between gap-2">
          <UiButton variant="ghost" data-test="add-instance-later" @click="close">
            {{ $t("settings.addInstanceLater") }}
          </UiButton>
          <UiButton variant="secondary" data-test="add-instance-regenerate" @click="copyCommand">
            {{ $t("settings.addInstanceRegenerate") }}
          </UiButton>
        </div>
      </div>

      <!-- Step 3: connected -->
      <div v-else class="mt-4">
        <p class="flex items-center gap-2 text-sm text-fg" data-test="add-instance-connected">
          <Check :size="16" class="text-run" />
          {{ $t("settings.addInstanceConnected", { name: connectedInstance?.name ?? name }) }}
        </p>
        <div class="mt-4 flex items-center justify-end gap-2">
          <UiButton data-test="add-instance-done" @click="close">
            {{ $t("settings.addInstanceDone") }}
          </UiButton>
        </div>
      </div>
  </DialogShell>
</template>
