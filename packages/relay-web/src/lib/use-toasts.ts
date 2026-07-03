import { ref } from "vue";

// A small global toast queue for imperative app messages (file-op results, etc).
// Distinct from `use-action-toast` (a single undo-style toast) and the server-driven
// `notices` store — this one stacks short-lived success/error/info toasts that
// auto-dismiss and can be closed by hand. Toast text is carried as an i18n key +
// params so the store layer stays i18n-free; ToastHost translates at render time.

export type ToastTone = "success" | "error" | "info";
export interface ToastItem {
  id: number;
  tone: ToastTone;
  key: string;
  params?: Record<string, unknown>;
}

const MAX = 4;
const DEFAULT_MS = 4000;

const items = ref<ToastItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let seq = 0;

export function useToasts() { return items; }

/** Queue a toast (newest first); auto-dismisses after `ms`. Returns its id. */
export function pushToast(tone: ToastTone, key: string, params?: Record<string, unknown>, ms = DEFAULT_MS): number {
  const id = ++seq;
  const next = [{ id, tone, key, params }, ...items.value];
  // Drop + clear timers for anything past the cap so background timers don't leak.
  for (const overflow of next.slice(MAX)) clearTimerFor(overflow.id);
  items.value = next.slice(0, MAX);
  timers.set(id, setTimeout(() => dismissToast(id), ms));
  return id;
}

export function dismissToast(id: number): void {
  clearTimerFor(id);
  items.value = items.value.filter((n) => n.id !== id);
}

function clearTimerFor(id: number): void {
  const t = timers.get(id);
  if (t) { clearTimeout(t); timers.delete(id); }
}
