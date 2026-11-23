import { ref, onMounted, onBeforeUnmount, type Ref } from "vue";

// True when `t` is a text-editing element the on-screen keyboard would open for.
function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

// Reactive height (px) the on-screen keyboard covers at the bottom of the viewport; 0 when
// closed. Detected via visualViewport, gated two ways so browser chrome never counts:
//   1. Only while an editable element is focused — a keyboard can't be open otherwise, so a
//      persistent mobile browser toolbar never leaves a phantom inset.
//   2. Only above a keyboard-sized threshold (a toolbar is <=~90px; real keyboards >=~150px).
// When the browser resizes the layout viewport for the keyboard the raw delta is ~0, so this
// stays a no-op and never double-applies. Callers typically use it to drop a bottom
// safe-area inset (which the keyboard already covers) so content sits flush on the keyboard.
export function useVirtualKeyboardInset(): Ref<number> {
  const KEYBOARD_MIN_INSET = 120;
  const inset = ref(0);
  let focused = false;

  function update() {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv || !focused) { inset.value = 0; return; }
    const raw = Math.round(window.innerHeight - vv.height - vv.offsetTop);
    inset.value = raw > KEYBOARD_MIN_INSET ? raw : 0;
  }
  function onFocusIn(e: FocusEvent) { focused = isEditable(e.target); update(); }
  function onFocusOut() { focused = false; inset.value = 0; }

  onMounted(() => {
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focusout", onFocusOut);
  });
  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("scroll", update);
    window.removeEventListener("focusin", onFocusIn);
    window.removeEventListener("focusout", onFocusOut);
  });

  return inset;
}
