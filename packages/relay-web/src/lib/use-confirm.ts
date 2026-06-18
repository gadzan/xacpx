import { ref } from "vue";

export type ConfirmTone = "danger" | "default";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

// Single global slot — one confirm dialog at a time, hosted by <ConfirmDialog/> near
// the app root. Call sites await confirm({...}) and branch on the boolean.
const pending = ref<PendingConfirm | null>(null);

/** Reactive state for the dialog host. */
export function useConfirmState() {
  return pending;
}

/** Open a confirm dialog; resolves true if the user confirms, false otherwise.
 *  A second call supersedes any open dialog (resolving the first as cancelled). */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  pending.value?.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending.value = { ...options, resolve };
  });
}

/** Settle the open dialog (called by the host on confirm / cancel / dismiss). */
export function settleConfirm(ok: boolean): void {
  const p = pending.value;
  pending.value = null;
  p?.resolve(ok);
}
