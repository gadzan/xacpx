import { nextTick, onBeforeUnmount, onMounted, type Ref } from "vue";

/** Modal-dialog accessibility trio, shared by the overlay dialogs (ManageInstanceDialog,
 *  NewSessionDialog): trap Tab focus inside the dialog, close on Escape, and restore focus
 *  to whatever was focused before the dialog opened. The caller owns the markup contract:
 *  put `ref` on the dialog panel, plus `tabindex="-1" role="dialog" aria-modal="true"`
 *  (and an `aria-labelledby` pointing at the title).
 *
 *  The keydown listener sits on `document`, so a child that must swallow Escape itself
 *  (e.g. an open combobox closing its own popup) simply calls `e.stopPropagation()`.
 *
 *  Nested dialogs: a module-level stack tracks every registered dialog; only the
 *  top-most (last mounted) one acts on Escape, so closing a child never also
 *  closes the parent behind it. Tab trapping stays per-dialog. */
const stack: Array<() => void> = [];

export function useModalA11y(dialogEl: Ref<HTMLElement | null>, close: () => void): void {
  let previouslyFocused: HTMLElement | null = null;
  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function focusables(): HTMLElement[] {
    return dialogEl.value ? Array.from(dialogEl.value.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (stack[stack.length - 1] !== close) return; // a nested dialog on top owns Escape
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const els = focusables();
    if (els.length === 0) return;
    const first = els[0], last = els[els.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
  onMounted(() => {
    stack.push(close);
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener("keydown", onKeydown);
    void nextTick(() => {
      (focusables()[0] ?? dialogEl.value)?.focus();
    });
  });
  onBeforeUnmount(() => {
    const i = stack.indexOf(close);
    if (i !== -1) stack.splice(i, 1);
    document.removeEventListener("keydown", onKeydown);
    previouslyFocused?.focus?.();
  });
}
