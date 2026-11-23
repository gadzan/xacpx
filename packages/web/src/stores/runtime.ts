import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../api/client";
import {
  LEGACY_RELAY_RUNTIME,
  normalizeRuntimeConfig,
  type WebRuntimeConfig,
} from "../lib/runtime-config";

export const useRuntimeStore = defineStore("runtime", () => {
  const config = ref<WebRuntimeConfig>({ ...LEGACY_RELAY_RUNTIME, capabilities: { ...LEGACY_RELAY_RUNTIME.capabilities } });
  const loaded = ref(false);

  async function ensure(): Promise<WebRuntimeConfig> {
    if (loaded.value) return config.value;
    try {
      config.value = normalizeRuntimeConfig(await api.get<unknown>("/api/config"));
    } catch {
      // An old hub answers 401 here. That is the relay dashboard.
      config.value = { ...LEGACY_RELAY_RUNTIME, capabilities: { ...LEGACY_RELAY_RUNTIME.capabilities } };
    }
    loaded.value = true;
    return config.value;
  }

  return { config, loaded, ensure };
});
