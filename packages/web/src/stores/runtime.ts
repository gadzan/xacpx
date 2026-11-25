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

  /**
   * Re-read the host description once, ignoring any cached answer.
   *
   * A single 401/404 latches the relay fallback above, and nothing else ever
   * clears it — so a host that was briefly unreachable (restarting daemon, a
   * proxy error page, a stale service worker answering the first request) keeps
   * the whole session on the relay runtime and sends the reader to the login
   * page with no way back short of clearing site data. The login page calls this
   * before rendering so a misread host corrects itself.
   */
  async function recheck(): Promise<WebRuntimeConfig> {
    loaded.value = false;
    return await ensure();
  }

  return { config, loaded, ensure, recheck };
});
