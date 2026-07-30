import { defineStore } from "pinia";
import { ref, watch } from "vue";
import {
  isErrorPayload,
  type SessionEffortResult,
  type SessionEffortSetResult,
  type SessionModelResult,
  type SessionModelSetResult,
} from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { pushToast } from "../lib/use-toasts";
import * as viewCache from "../lib/view-snapshot-cache";
import { useAuthStore } from "./auth";

type ControlSnapshot = { current?: string; available: string[] };

/** Per-session model and effort controls for the composer chips. The hub stamps chatKey for
 *  these chat-scoped RPCs, so the web only sends sessionAlias. */
export const useSessionControlsStore = defineStore("session-controls", () => {
  const modelCurrent = ref<string | undefined>(undefined);
  const modelAvailable = ref<string[]>([]);
  const modelLoading = ref(false);
  const effortCurrent = ref<string | undefined>(undefined);
  const effortAvailable = ref<string[]>([]);
  const effortLoading = ref(false);
  let activeContext: string | null = null;
  let requestRevision = 0;
  const pendingModelSets = new Map<string, Promise<void>>();
  const authoritativeModels = new Map<string, { revision: number; current: string | undefined }>();
  let effortActiveContext: string | null = null;
  let effortRevision = 0;
  const pendingEffortSets = new Map<string, Promise<void>>();
  const authoritativeEfforts = new Map<string, { revision: number; current: string | undefined }>();

  const cacheUser = (): string | null => useAuthStore().account?.username ?? null;
  const contextKey = (instanceId: string, alias: string): string => `${instanceId}\u0000${alias}`;
  const isCurrentRequest = (context: string, revision: number): boolean =>
    activeContext === context && requestRevision === revision;
  function recordAuthoritativeModel(context: string, revision: number, model: string | undefined): void {
    const existing = authoritativeModels.get(context);
    if (!existing || revision >= existing.revision) {
      authoritativeModels.set(context, { revision, current: model });
    }
  }
  function rollbackModel(context: string, fallback: string | undefined): string | undefined {
    const authoritative = authoritativeModels.get(context);
    return authoritative ? authoritative.current : fallback;
  }
  function recordAuthoritativeEffort(context: string, revision: number, effort: string | undefined): void {
    const existing = authoritativeEfforts.get(context);
    if (!existing || revision >= existing.revision) {
      authoritativeEfforts.set(context, { revision, current: effort });
    }
  }
  function rollbackEffort(context: string, fallback: string | undefined): string | undefined {
    const authoritative = authoritativeEfforts.get(context);
    return authoritative ? authoritative.current : fallback;
  }

  function clearModelState(): void {
    modelCurrent.value = undefined;
    modelAvailable.value = [];
  }

  function clearEffortState(): void {
    effortCurrent.value = undefined;
    effortAvailable.value = [];
  }

  function applyModelSnapshot(snapshot: ControlSnapshot): void {
    modelCurrent.value = snapshot.current;
    modelAvailable.value = Array.isArray(snapshot.available) ? snapshot.available : [];
  }
  function applyEffortSnapshot(snapshot: ControlSnapshot): void {
    effortCurrent.value = snapshot.current;
    effortAvailable.value = Array.isArray(snapshot.available) ? snapshot.available : [];
  }
  function cacheModel(
    user: string | null,
    instanceId: string,
    alias: string,
    snapshot: ControlSnapshot,
    token: viewCache.SnapshotWriteToken | null,
  ): void {
    if (user && token && cacheUser() === user) {
      void viewCache.write(user, "session-model", instanceId, alias, snapshot, token);
    }
  }
  function cacheEffort(
    user: string | null,
    instanceId: string,
    alias: string,
    snapshot: ControlSnapshot,
    token: viewCache.SnapshotWriteToken | null,
  ): void {
    if (user && token && cacheUser() === user) {
      void viewCache.write(user, "session-effort", instanceId, alias, snapshot, token);
    }
  }

  function reset(): void {
    activeContext = null;
    requestRevision += 1;
    modelLoading.value = false;
    clearModelState();
    effortActiveContext = null;
    effortRevision += 1;
    effortLoading.value = false;
    clearEffortState();
  }

  async function loadModel(instanceId: string | null, alias: string | null): Promise<void> {
    if (!instanceId || !alias) { reset(); return; }
    const context = contextKey(instanceId, alias);
    if (activeContext !== context) clearModelState();
    activeContext = context;
    const revision = ++requestRevision;
    const cacheOwner = cacheUser();
    const cacheToken = cacheOwner
      ? viewCache.captureWriteToken(cacheOwner, "session-model", instanceId, alias)
      : null;
    modelLoading.value = true;
    let seeded = false;
    try {
      // Never paint a pre-mutation cache while a model change for this exact
      // session is still settling. The authoritative cache is updated by setModel.
      const pendingSet = pendingModelSets.get(context);
      if (pendingSet) {
        await pendingSet;
        if (!isCurrentRequest(context, revision)) return;
      }
      const user = cacheOwner;
      if (user) {
        const snapshot = viewCache.peek<ControlSnapshot>(user, "session-model", instanceId, alias)
          ?? await viewCache.read<ControlSnapshot>(user, "session-model", instanceId, alias);
        if (!isCurrentRequest(context, revision) || cacheUser() !== user) return;
        if (snapshot) {
          applyModelSnapshot(snapshot);
          seeded = true;
        }
      }
      // A remount/session round-trip can request a fresh read while an earlier
      // selection for this same session is still being reconciled. Read only
      // after the latest mutation settles, otherwise the load can publish the
      // pre-mutation model and make the later set response look stale.
      const r = await api.rpc<SessionModelResult>(instanceId, "control.session.model.get", { sessionAlias: alias });
      if (!isCurrentRequest(context, revision)) return;
      if (isErrorPayload(r)) {
        if (!seeded) clearModelState();
        return;
      }
      modelCurrent.value = typeof r.current === "string" ? r.current : undefined;
      recordAuthoritativeModel(context, revision, modelCurrent.value);
      // Never trust the wire to hand back an array — a malformed/partial result must
      // not blow up the composer's `available.length` reads (white-screens the input).
      modelAvailable.value = Array.isArray(r.available) ? r.available : [];
      cacheModel(cacheOwner, instanceId, alias, { current: modelCurrent.value, available: modelAvailable.value }, cacheToken);
    } catch {
      if (isCurrentRequest(context, revision) && !seeded) clearModelState();
    } finally {
      if (isCurrentRequest(context, revision)) modelLoading.value = false;
    }
  }

  async function setModel(instanceId: string, alias: string, id: string): Promise<boolean> {
    // Reflect the choice in the chip immediately. The backend `set` spawns acpx and can
    // take a second or two (or time out), so updating only AFTER the RPC left the chip
    // showing the old model until the next session switch. Revert if the switch fails.
    const context = contextKey(instanceId, alias);
    if (activeContext !== context) clearModelState();
    activeContext = context;
    const cacheOwner = cacheUser();
    const cacheToken = cacheOwner
      ? viewCache.captureWriteToken(cacheOwner, "session-model", instanceId, alias)
      : null;
    const prev = modelCurrent.value;
    const availableAtSet = [...modelAvailable.value];
    const revision = ++requestRevision;
    // This mutation supersedes any in-flight model load for the same UI store.
    // Its stale finally block is intentionally ignored, so clear the spinner now.
    modelLoading.value = false;
    modelCurrent.value = id;
    const operation = (async (): Promise<boolean> => {
      try {
        const r = await api.rpc<SessionModelSetResult>(instanceId, "control.session.model.set", { sessionAlias: alias, modelId: id });
        if (isErrorPayload(r)) {
          if (isCurrentRequest(context, revision)) {
            modelCurrent.value = rollbackModel(context, prev);
            reportModelSwitchFailure(r.error.message);
          }
          return false;
        }
        if (r.ok === false) {
          const observed = r.current === null
            ? undefined
            : typeof r.current === "string" ? r.current : rollbackModel(context, prev);
          recordAuthoritativeModel(context, revision, observed);
          cacheModel(cacheOwner, instanceId, alias, { current: observed, available: availableAtSet }, cacheToken);
          if (isCurrentRequest(context, revision)) {
            modelCurrent.value = observed;
            reportModelSwitchFailure(
              `requested ${id}; authoritative model is ${r.current ?? "unknown"}`,
            );
          }
          return false;
        }
        const observed = r.current === null
          ? undefined
          : typeof r.current === "string" ? r.current : id;
        recordAuthoritativeModel(context, revision, observed);
        cacheModel(cacheOwner, instanceId, alias, { current: observed, available: availableAtSet }, cacheToken);
        if (isCurrentRequest(context, revision)) {
          modelCurrent.value = observed;
        }
        return true;
      } catch (e) {
        if (isCurrentRequest(context, revision)) {
          modelCurrent.value = rollbackModel(context, prev);
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

  async function loadEffort(instanceId: string | null, alias: string | null): Promise<void> {
    if (!instanceId || !alias) {
      effortActiveContext = null;
      effortRevision += 1;
      effortLoading.value = false;
      clearEffortState();
      return;
    }
    const context = contextKey(instanceId, alias);
    if (effortActiveContext !== context) clearEffortState();
    effortActiveContext = context;
    const revision = ++effortRevision;
    const cacheOwner = cacheUser();
    const cacheToken = cacheOwner
      ? viewCache.captureWriteToken(cacheOwner, "session-effort", instanceId, alias)
      : null;
    effortLoading.value = true;
    let seeded = false;
    try {
      const pendingSet = pendingEffortSets.get(context);
      if (pendingSet) {
        await pendingSet;
        if (effortActiveContext !== context || effortRevision !== revision) return;
      }
      const user = cacheOwner;
      if (user) {
        const snapshot = viewCache.peek<ControlSnapshot>(user, "session-effort", instanceId, alias)
          ?? await viewCache.read<ControlSnapshot>(user, "session-effort", instanceId, alias);
        if (effortActiveContext !== context || effortRevision !== revision || cacheUser() !== user) return;
        if (snapshot) {
          applyEffortSnapshot(snapshot);
          seeded = true;
        }
      }
      const effortResult = await api.rpc<SessionEffortResult>(instanceId, "control.session.effort.get", { sessionAlias: alias });
      if (effortActiveContext !== context || effortRevision !== revision) return;
      if (isErrorPayload(effortResult)) {
        if (!seeded) clearEffortState();
        return;
      }
      effortCurrent.value = typeof effortResult.current === "string" ? effortResult.current : undefined;
      recordAuthoritativeEffort(context, revision, effortCurrent.value);
      effortAvailable.value = Array.isArray(effortResult.available) ? effortResult.available : [];
      cacheEffort(cacheOwner, instanceId, alias, { current: effortCurrent.value, available: effortAvailable.value }, cacheToken);
    } catch {
      if (effortActiveContext === context && effortRevision === revision && !seeded) clearEffortState();
    } finally {
      if (effortActiveContext === context && effortRevision === revision) effortLoading.value = false;
    }
  }

  async function setEffort(instanceId: string, alias: string, effort: string): Promise<boolean> {
    const context = contextKey(instanceId, alias);
    if (effortActiveContext !== context) clearEffortState();
    effortActiveContext = context;
    const cacheOwner = cacheUser();
    const cacheToken = cacheOwner
      ? viewCache.captureWriteToken(cacheOwner, "session-effort", instanceId, alias)
      : null;
    const previous = authoritativeEfforts.get(context)?.current ?? effortCurrent.value;
    const availableAtSet = [...effortAvailable.value];
    const revision = ++effortRevision;
    effortLoading.value = false;
    effortCurrent.value = effort;
    const operation = (async (): Promise<boolean> => {
      try {
        const setResult = await api.rpc<SessionEffortSetResult>(instanceId, "control.session.effort.set", {
          sessionAlias: alias,
          effort,
        });
        if (isErrorPayload(setResult) || setResult.ok === false) {
          if (effortActiveContext === context && effortRevision === revision) {
            let observed = rollbackEffort(context, previous);
            if (!isErrorPayload(setResult) && (setResult.current === null || typeof setResult.current === "string")) {
              observed = setResult.current ?? undefined;
              recordAuthoritativeEffort(context, revision, observed);
              cacheEffort(cacheOwner, instanceId, alias, { current: observed, available: availableAtSet }, cacheToken);
            }
            effortCurrent.value = observed;
            reportEffortSwitchFailure(isErrorPayload(setResult) ? setResult.error.message : `requested ${effort} was not applied`);
          }
          return false;
        }
        const observed = typeof setResult.current === "string" ? setResult.current : effort;
        recordAuthoritativeEffort(context, revision, observed);
        cacheEffort(cacheOwner, instanceId, alias, { current: observed, available: availableAtSet }, cacheToken);
        if (effortActiveContext === context && effortRevision === revision) effortCurrent.value = observed;
        return true;
      } catch (error) {
        if (effortActiveContext === context && effortRevision === revision) {
          effortCurrent.value = rollbackEffort(context, previous);
          reportEffortSwitchFailure(error instanceof Error ? error.message : "set-failed");
        }
        return false;
      }
    })();
    const settled = operation.then(() => undefined, () => undefined);
    pendingEffortSets.set(context, settled);
    try {
      return await operation;
    } finally {
      if (pendingEffortSets.get(context) === settled) pendingEffortSets.delete(context);
    }
  }

  function waitForEffortSet(instanceId: string, alias: string): Promise<void> | undefined {
    return pendingEffortSets.get(contextKey(instanceId, alias));
  }

  const auth = useAuthStore();
  watch(() => auth.account?.username ?? null, () => reset(), { flush: "sync" });

  return {
    modelCurrent, modelAvailable, modelLoading, reset, loadModel, setModel,
    effortCurrent, effortAvailable, effortLoading, loadEffort, setEffort, waitForEffortSet,
  };
});

function reportModelSwitchFailure(detail: string): void {
  // Keep command lines and captured output out of the compact composer UI. They remain
  // available in browser diagnostics while the user sees the app's standard toast.
  console.error("[relay-web] model switch failed", detail);
  pushToast("error", "chat.modelSetFailed");
}

function reportEffortSwitchFailure(detail: string): void {
  console.error("[relay-web] effort switch failed", detail);
  pushToast("error", "chat.effortSetFailed");
}
