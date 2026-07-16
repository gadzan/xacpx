import { defineStore } from "pinia";
import { ref } from "vue";
import {
  isErrorPayload,
  type SessionModelResult,
  type SessionModelSetResult,
} from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { pushToast } from "../lib/use-toasts";

/** Per-session model controls for the composer chip. The hub stamps chatKey for
 *  these chat-scoped RPCs, so the web only sends sessionAlias. */
export const useSessionControlsStore = defineStore("session-controls", () => {
  const current = ref<string | undefined>(undefined);
  const available = ref<string[]>([]);
  const loading = ref(false);

  function reset(): void {
    current.value = undefined;
    available.value = [];
  }

  async function loadModel(instanceId: string | null, alias: string | null): Promise<void> {
    if (!instanceId || !alias) { reset(); return; }
    loading.value = true;
    try {
      const r = await api.rpc<SessionModelResult>(instanceId, "control.session.model.get", { sessionAlias: alias });
      if (isErrorPayload(r)) { reset(); return; }
      current.value = typeof r.current === "string" ? r.current : undefined;
      // Never trust the wire to hand back an array — a malformed/partial result must
      // not blow up the composer's `available.length` reads (white-screens the input).
      available.value = Array.isArray(r.available) ? r.available : [];
    } catch {
      reset();
    } finally {
      loading.value = false;
    }
  }

  async function setModel(instanceId: string, alias: string, id: string): Promise<boolean> {
    // Reflect the choice in the chip immediately. The backend `set` spawns acpx and can
    // take a second or two (or time out), so updating only AFTER the RPC left the chip
    // showing the old model until the next session switch. Revert if the switch fails.
    const prev = current.value;
    current.value = id;
    try {
      const r = await api.rpc<SessionModelSetResult>(instanceId, "control.session.model.set", { sessionAlias: alias, modelId: id });
      if (isErrorPayload(r)) {
        current.value = prev;
        reportModelSwitchFailure(r.error.message);
        return false;
      }
      if (r.ok === false) {
        current.value = r.current === null
          ? undefined
          : typeof r.current === "string" ? r.current : prev;
        reportModelSwitchFailure(
          `requested ${id}; authoritative model is ${r.current ?? "unknown"}`,
        );
        return false;
      }
      if (r.current === null) current.value = undefined;
      else if (typeof r.current === "string") current.value = r.current;
      return true;
    } catch (e) {
      current.value = prev;
      reportModelSwitchFailure(e instanceof Error ? e.message : "set-failed");
      return false;
    }
  }

  return { current, available, loading, reset, loadModel, setModel };
});

function reportModelSwitchFailure(detail: string): void {
  // Keep command lines and captured output out of the compact composer UI. They remain
  // available in browser diagnostics while the user sees the app's standard toast.
  console.error("[relay-web] model switch failed", detail);
  pushToast("error", "chat.modelSetFailed");
}
