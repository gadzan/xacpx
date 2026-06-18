import { defineStore } from "pinia";
import { ref } from "vue";
import { isErrorPayload, type SessionModelResult } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";

/** Per-session model controls for the composer chip. The hub stamps chatKey for
 *  these chat-scoped RPCs, so the web only sends sessionAlias. */
export const useSessionControlsStore = defineStore("session-controls", () => {
  const current = ref<string | undefined>(undefined);
  const available = ref<string[]>([]);
  const loading = ref(false);
  const error = ref("");

  function reset(): void {
    current.value = undefined;
    available.value = [];
    error.value = "";
  }

  async function loadModel(instanceId: string | null, alias: string | null): Promise<void> {
    if (!instanceId || !alias) { reset(); return; }
    loading.value = true;
    error.value = "";
    try {
      const r = await api.rpc<SessionModelResult>(instanceId, "control.session.model.get", { sessionAlias: alias });
      if (isErrorPayload(r)) { reset(); return; }
      current.value = r.current;
      available.value = r.available;
    } catch {
      reset();
    } finally {
      loading.value = false;
    }
  }

  async function setModel(instanceId: string, alias: string, id: string): Promise<boolean> {
    error.value = "";
    // Reflect the choice in the chip immediately. The backend `set` spawns acpx and can
    // take a second or two (or time out), so updating only AFTER the RPC left the chip
    // showing the old model until the next session switch. Revert if the switch fails.
    const prev = current.value;
    current.value = id;
    try {
      const r = await api.rpc<{ ok?: boolean }>(instanceId, "control.session.model.set", { sessionAlias: alias, modelId: id });
      if (isErrorPayload(r)) { current.value = prev; error.value = r.error.message; return false; }
      return true;
    } catch (e) {
      current.value = prev;
      error.value = e instanceof Error ? e.message : "set-failed";
      return false;
    }
  }

  return { current, available, loading, error, reset, loadModel, setModel };
});
