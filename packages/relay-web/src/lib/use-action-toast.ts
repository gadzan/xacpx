import { ref } from "vue";

export interface ActionToast {
  message: string;
  actionLabel: string;
  action: () => void;
}

const current = ref<ActionToast | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

export function useActionToastState() { return current; }

/** Show a toast with one action button; auto-dismisses after `ms` (default 6s). */
export function showActionToast(toast: ActionToast, ms = 6000): void {
  if (timer) clearTimeout(timer);
  current.value = toast;
  timer = setTimeout(() => { current.value = null; timer = null; }, ms);
}

export function runToastAction(): void {
  const t = current.value;
  current.value = null;
  if (timer) { clearTimeout(timer); timer = null; }
  t?.action();
}

export function dismissToast(): void {
  current.value = null;
  if (timer) { clearTimeout(timer); timer = null; }
}
