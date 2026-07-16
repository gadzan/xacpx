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
  let activeContext: string | null = null;
  let requestRevision = 0;
  const pendingModelSets = new Map<string, Promise<void>>();

  const contextKey = (instanceId: string, alias: string): string => `${instanceId}\u0000${alias}`;
  const isCurrentRequest = (context: string, revision: number): boolean =>
    activeContext === context && requestRevision === revision;

  function clearModelState(): void {
    current.value = undefined;
    available.value = [];
  }

  function reset(): void {
    activeContext = null;
    requestRevision += 1;
    loading.value = false;
    clearModelState();
  }

  async function loadModel(instanceId: string | null, alias: string | null): Promise<void> {
    if (!instanceId || !alias) { reset(); return; }
    const context = contextKey(instanceId, alias);
    if (activeContext !== context) clearModelState();
    activeContext = context;
    const revision = ++requestRevision;
    loading.value = true;
    try {
      // A remount/session round-trip can request a fresh read while an earlier
      // selection for this same session is still being reconciled. Read only
      // after the latest mutation settles, otherwise the load can publish the
      // pre-mutation model and make the later set response look stale.
      const pendingSet = pendingModelSets.get(context);
      if (pendingSet) {
        await pendingSet;
        if (!isCurrentRequest(context, revision)) return;
      }
      const r = await api.rpc<SessionModelResult>(instanceId, "control.session.model.get", { sessionAlias: alias });
      if (!isCurrentRequest(context, revision)) return;
      if (isErrorPayload(r)) { clearModelState(); return; }
      current.value = typeof r.current === "string" ? r.current : undefined;
      // Never trust the wire to hand back an array — a malformed/partial result must
      // not blow up the composer's `available.length` reads (white-screens the input).
      available.value = Array.isArray(r.available) ? r.available : [];
    } catch {
      if (isCurrentRequest(context, revision)) clearModelState();
    } finally {
      if (isCurrentRequest(context, revision)) loading.value = false;
    }
  }

  async function setModel(instanceId: string, alias: string, id: string): Promise<boolean> {
    // Reflect the choice in the chip immediately. The backend `set` spawns acpx and can
    // take a second or two (or time out), so updating only AFTER the RPC left the chip
    // showing the old model until the next session switch. Revert if the switch fails.
    const context = contextKey(instanceId, alias);
    if (activeContext !== context) clearModelState();
    activeContext = context;
    const prev = current.value;
    const revision = ++requestRevision;
    // This mutation supersedes any in-flight model load for the same UI store.
    // Its stale finally block is intentionally ignored, so clear the spinner now.
    loading.value = false;
    current.value = id;
    const operation = (async (): Promise<boolean> => {
      try {
        const r = await api.rpc<SessionModelSetResult>(instanceId, "control.session.model.set", { sessionAlias: alias, modelId: id });
        if (isErrorPayload(r)) {
          if (isCurrentRequest(context, revision)) {
            current.value = prev;
            reportModelSwitchFailure(r.error.message);
          }
          return false;
        }
        if (r.ok === false) {
          if (isCurrentRequest(context, revision)) {
            current.value = r.current === null
              ? undefined
              : typeof r.current === "string" ? r.current : prev;
            reportModelSwitchFailure(
              `requested ${id}; authoritative model is ${r.current ?? "unknown"}`,
            );
          }
          return false;
        }
        if (isCurrentRequest(context, revision)) {
          if (r.current === null) current.value = undefined;
          else if (typeof r.current === "string") current.value = r.current;
        }
        return true;
      } catch (e) {
        if (isCurrentRequest(context, revision)) {
          current.value = prev;
          reportModelSwitchFailure(e instanceof Error ? e.message : "set-failed");
        }
        return false;
      }
    })();
    const settled = operation.then(() => undefined, () => undefined);
    pendingModelSets.set(context, settled);
    try {
      return await operation;
    } finally {
      if (pendingModelSets.get(context) === settled) {
        pendingModelSets.delete(context);
      }
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
