import { ref, watch, onMounted, onBeforeUnmount, type Ref } from "vue";

// Reactive content-box width (px) of `target`, driven by ResizeObserver. Stays 0 when
// ResizeObserver is unavailable (jsdom/embedded runtimes) so callers degrade to their
// narrow-screen behavior — same philosophy as the matchMedia fallback in PromptInput.
// The target may be null at mount (e.g. behind a v-if) — observation follows the ref.
export function useElementWidth(target: Ref<HTMLElement | null>): Ref<number> {
  const width = ref(0);
  let observer: ResizeObserver | null = null;

  onMounted(() => {
    if (typeof ResizeObserver !== "function") return;
    observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) width.value = entry.contentRect.width;
    });
    if (target.value) observer.observe(target.value);
  });
  watch(target, (el) => {
    if (!observer) return;
    observer.disconnect();
    if (el) observer.observe(el);
  });
  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return width;
}
