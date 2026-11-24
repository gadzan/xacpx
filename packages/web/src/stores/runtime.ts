import { defineStore } from "pinia";
import { ref } from "vue";
import { ApiError, api } from "../api/client";
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
      loaded.value = true;
    } catch (error) {
      // An old hub answers 401 (the route used to require a session) or 404.
      // A network blip or a 5xx must not stick: the next navigation tries again.
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 401 || status === 404) {
        config.value = { ...LEGACY_RELAY_RUNTIME, capabilities: { ...LEGACY_RELAY_RUNTIME.capabilities } };
        loaded.value = true;
      }
    }
    return config.value;
  }

  return { config, loaded, ensure };
});
