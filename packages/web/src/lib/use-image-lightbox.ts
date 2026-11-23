import { computed, ref } from "vue";

// Global fullscreen image viewer state (module singleton, same pattern as
// use-toasts) so any renderer — MessageAttachments thumbnails, StreamMarkdown's
// delegated img clicks — can open it without prop drilling through the chat pane.
// The opener hands in the FULL ordered image list of its bubble/segment plus the
// clicked index; the viewer then swipes prev/next within that list.
export interface LightboxImage {
  src: string;
  alt?: string;
}

interface LightboxState {
  images: LightboxImage[];
  index: number;
}

const state = ref<LightboxState | null>(null);

/** Open the viewer on `images` at `index` (clamped). No-op on an empty list. */
export function openLightbox(images: LightboxImage[], index = 0): void {
  if (images.length === 0) return;
  state.value = { images, index: Math.min(Math.max(index, 0), images.length - 1) };
}

export function closeLightbox(): void {
  state.value = null;
}

export function stepLightbox(delta: number): void {
  const s = state.value;
  if (!s) return;
  const next = s.index + delta;
  if (next < 0 || next >= s.images.length) return;
  s.index = next;
}

export function useImageLightbox() {
  const current = computed<LightboxImage | null>(() => {
    const s = state.value;
    return s ? (s.images[s.index] ?? null) : null;
  });
  const counter = computed(() => {
    const s = state.value;
    return s ? `${s.index + 1} / ${s.images.length}` : "";
  });
  const hasPrev = computed(() => !!state.value && state.value.index > 0);
  const hasNext = computed(() => !!state.value && state.value.index < state.value.images.length - 1);
  return { state, current, counter, hasPrev, hasNext };
}
