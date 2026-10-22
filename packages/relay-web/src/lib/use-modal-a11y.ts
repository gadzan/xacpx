import { nextTick, onBeforeUnmount, onMounted, type Ref } from "vue";
import { modalLayers, navigateBack, pushModal } from "./mobile-back";

/** Modal-dialog accessibility trio, shared by the overlay dialogs (ManageInstanceDialog,
 *  NewSessionDialog): trap Tab focus inside the dialog, close on Escape, and restore focus
 *  to whatever was focused before the dialog opened. The caller owns the markup contract:
 *  put `ref` on the dialog panel, plus `tabindex="-1" role="dialog" aria-modal="true"`
 *  (and an `aria-labelledby` pointing at the title). An optional initial-focus resolver
 *  takes precedence over the default first focusable control.
 *
 *  The keydown listener sits on `document`, so a child that must swallow Escape itself
 *  (e.g. an open combobox closing its own popup) simply calls `e.stopPropagation()`.
 *
 *  Nested dialogs: a module-level stack tracks every registered dialog; only the
 *  top-most (last mounted) one acts on Escape, so closing a child never also
 *  closes the parent behind it. Tab trapping stays per-dialog.
 *
 *  That stack is the same one the mobile back navigation walks (see mobile-back), so
 *  the two orders can never drift: Escape and ← both close the top-most layer, and
 *  the layer's close affordances call `navigateBack()` so the popstate performs the
 *  close. */
export interface ModalA11yOptions {
  /** The panel renders only below lg (MobileSheet and the sheets DropdownPanel renders
   *  there). Crossing to ≥lg closes it instead of leaving it mounted and invisible. */
  mobileOnly?: boolean;
  initialFocus?: () => HTMLElement | null;
}

export function useModalA11y(
  dialogEl: Ref<HTMLElement | null>,
  close: () => void,
  options: ModalA11yOptions = {},
): void {
  let previouslyFocused: HTMLElement | null = null;
  let unregister: (() => void) | null = null;
  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function focusables(): HTMLElement[] {
    return dialogEl.value ? Array.from(dialogEl.value.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      // A floating layer inside the dialog (dropdown) already consumed this Escape.
      if (e.defaultPrevented) return;
      if (modalLayers.value[modalLayers.value.length - 1]?.close !== close) return; // a nested dialog on top owns Escape
      e.preventDefault();
      navigateBack();
      return;
    }
    if (e.key !== "Tab") return;
    const els = focusables();
    if (els.length === 0) return;
    const first = els[0]!, last = els[els.length - 1]!;
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
    const el = dialogEl.value;
    unregister = pushModal({
      id: el?.getAttribute("data-test") || el?.getAttribute("aria-label") || "modal",
      close,
      mobileOnly: options.mobileOnly,
    });
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener("keydown", onKeydown);
    void nextTick(() => {
      (options.initialFocus?.() ?? focusables()[0] ?? dialogEl.value)?.focus();
    });
  });
  onBeforeUnmount(() => {
    unregister?.();
    unregister = null;
    document.removeEventListener("keydown", onKeydown);
    previouslyFocused?.focus?.();
  });
}
