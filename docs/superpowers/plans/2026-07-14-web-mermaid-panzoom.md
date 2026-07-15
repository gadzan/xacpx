# Web Mermaid Pan/Zoom Implementation Plan (inline + fullscreen)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rendered Mermaid diagrams are pan/zoomable **inline** (Ctrl/⌘+wheel zoom, mouse-drag pan, two-finger pinch; one-finger touch still scrolls the page) and **fullscreen** via a ⤢ button (plain wheel, one-finger drag, pinch).

**Architecture:** `pan-zoom.ts` (pure controller, DONE) + `pan-zoom-gestures.ts` (shared DOM gesture wiring, mode flags) + `MermaidViewer.vue` (fullscreen overlay) + `inline-mermaid.ts` (in-place enhancement of a rendered block) + `StreamMarkdown.vue` wiring. `render-mermaid.ts` is unchanged.

**Tech Stack:** Vue 3, `lucide-vue-next` icons, existing `useModalA11y`, Vitest (jsdom) + @vue/test-utils.

## Global Constraints

- All code in `packages/relay-web`. Tests: `npx vitest run` from `packages/relay-web` — never `bun test`.
- No new npm dependency.
- Security: inline enhancement and the viewer operate on the SVG `render-mermaid` already produced and DOMPurified — moved/re-displayed, never re-parsed. mermaid stays `securityLevel: "strict"`.
- `render-mermaid.ts` and the existing hydration/streaming/theme logic in `StreamMarkdown.vue` stay behaviourally unchanged (StreamMarkdown gains only the enhance + viewer wiring).
- Inline must never hijack the page: wheel zoom requires Ctrl/⌘; one-finger touch is left to the browser (`touch-action: pan-y`). Fullscreen owns all gestures (`touch-action: none`).
- Task 1 (`pan-zoom.ts`) is already implemented and committed — do not touch it.

---

### Task 2: `pan-zoom-gestures.ts` — shared gesture wiring

**Files:**
- Create: `packages/relay-web/src/lib/pan-zoom-gestures.ts`
- Test: `packages/relay-web/src/__tests__/pan-zoom-gestures.test.ts`

**Interfaces:**
- Consumes: `PanZoom` type from `./pan-zoom`.
- Produces: `attachPanZoomGestures(el, pz, onChange, opts?): () => void` and `interface GestureOptions { wheelRequiresModifier?: boolean; oneFingerTouchPan?: boolean }`. Consumed by Tasks 3 and 4.

- [ ] **Step 1: Write the failing tests**

Create `packages/relay-web/src/__tests__/pan-zoom-gestures.test.ts`:
```ts
import { afterEach, expect, test } from "vitest";
import { createPanZoom } from "../lib/pan-zoom";
import { attachPanZoomGestures } from "../lib/pan-zoom-gestures";

let detach: (() => void) | null = null;
afterEach(() => { detach?.(); detach = null; document.body.innerHTML = ""; });

// jsdom lacks real WheelEvent/PointerEvent/TouchEvent ergonomics; dispatch a bare Event with the
// properties the handlers read assigned onto it.
function fire(el: EventTarget, type: string, props: Record<string, unknown>): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, props);
  el.dispatchEvent(e);
}
function el(): HTMLElement {
  const d = document.createElement("div");
  document.body.appendChild(d);
  return d;
}

test("wheelRequiresModifier: plain wheel is a no-op, Ctrl+wheel zooms", () => {
  const target = el();
  const pz = createPanZoom();
  detach = attachPanZoomGestures(target, pz, () => {}, { wheelRequiresModifier: true });
  fire(target, "wheel", { deltaY: -100, clientX: 0, clientY: 0 });
  expect(pz.state.scale).toBe(1); // plain wheel ignored → page scrolls
  fire(target, "wheel", { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
  expect(pz.state.scale).toBeCloseTo(1.1);
});

test("without wheelRequiresModifier a plain wheel zooms", () => {
  const target = el();
  const pz = createPanZoom();
  detach = attachPanZoomGestures(target, pz, () => {});
  fire(target, "wheel", { deltaY: 100, clientX: 0, clientY: 0 });
  expect(pz.state.scale).toBeCloseTo(1 / 1.1);
});

test("mouse pointer drag pans", () => {
  const target = el();
  const pz = createPanZoom();
  detach = attachPanZoomGestures(target, pz, () => {});
  fire(target, "pointerdown", { pointerType: "mouse", pointerId: 1, clientX: 0, clientY: 0 });
  fire(target, "pointermove", { pointerType: "mouse", pointerId: 1, clientX: 25, clientY: 40 });
  fire(target, "pointerup", { pointerType: "mouse", pointerId: 1 });
  expect(pz.state.x).toBe(25);
  expect(pz.state.y).toBe(40);
});

test("two-finger touch pinch zooms", () => {
  const target = el();
  const pz = createPanZoom();
  detach = attachPanZoomGestures(target, pz, () => {});
  fire(target, "touchstart", { touches: [{ clientX: 0, clientY: 0 }, { clientX: 10, clientY: 0 }] });
  fire(target, "touchmove", { touches: [{ clientX: 0, clientY: 0 }, { clientX: 20, clientY: 0 }] });
  expect(pz.state.scale).toBeCloseTo(2); // distance 10 → 20
});

test("detach stops all gestures", () => {
  const target = el();
  const pz = createPanZoom();
  const d = attachPanZoomGestures(target, pz, () => {});
  d();
  fire(target, "wheel", { deltaY: -100, clientX: 0, clientY: 0 });
  expect(pz.state.scale).toBe(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/relay-web && npx vitest run src/__tests__/pan-zoom-gestures.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `pan-zoom-gestures.ts`**

Create `packages/relay-web/src/lib/pan-zoom-gestures.ts`:
```ts
import type { PanZoom } from "./pan-zoom";

export interface GestureOptions {
  /** Zoom on wheel only when Ctrl/⌘ is held (inline). Default false. */
  wheelRequiresModifier?: boolean;
  /** Pan on a single touch (fullscreen). Default false — one finger scrolls the page. */
  oneFingerTouchPan?: boolean;
}

interface Pointish {
  clientX: number;
  clientY: number;
}

/**
 * Attach wheel/pointer/touch pan-zoom gestures on `el`, driving `pz` and calling `onChange` after
 * every state change. Mouse drag always pans; touch panning is one-finger only when opted in;
 * wheel zoom can require a modifier. Returns a detach function that removes every listener.
 */
export function attachPanZoomGestures(
  el: HTMLElement,
  pz: PanZoom,
  onChange: () => void,
  opts: GestureOptions = {},
): () => void {
  const wheelRequiresModifier = opts.wheelRequiresModifier ?? false;
  const oneFingerTouchPan = opts.oneFingerTouchPan ?? false;

  function origin(): { left: number; top: number } {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  }
  function pinchDistance(a: Pointish, b: Pointish): number {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function onWheel(e: WheelEvent): void {
    if (wheelRequiresModifier && !e.ctrlKey && !e.metaKey) return; // let the page scroll
    e.preventDefault();
    const { left, top } = origin();
    pz.zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - left, e.clientY - top);
    onChange();
  }

  let dragging = false;
  let dragId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== "mouse") return; // touch handled below
    dragging = true;
    dragId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      /* jsdom / unsupported */
    }
  }
  function onPointerMove(e: PointerEvent): void {
    if (!dragging || e.pointerId !== dragId) return;
    pz.panBy(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
    onChange();
  }
  function onPointerUp(e: PointerEvent): void {
    if (e.pointerId === dragId) {
      dragging = false;
      dragId = null;
    }
  }

  let pinching = false;
  let prevDist = 0;
  let touchPanning = false;
  let touchX = 0;
  let touchY = 0;
  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length === 2) {
      pinching = true;
      touchPanning = false;
      prevDist = pinchDistance(e.touches[0]!, e.touches[1]!);
    } else if (e.touches.length === 1 && oneFingerTouchPan) {
      touchPanning = true;
      touchX = e.touches[0]!.clientX;
      touchY = e.touches[0]!.clientY;
    }
  }
  function onTouchMove(e: TouchEvent): void {
    if (pinching && e.touches.length === 2) {
      e.preventDefault();
      const { left, top } = origin();
      const dist = pinchDistance(e.touches[0]!, e.touches[1]!);
      if (prevDist > 0) {
        const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2 - left;
        const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2 - top;
        pz.zoomAt(dist / prevDist, midX, midY);
        onChange();
      }
      prevDist = dist;
    } else if (touchPanning && e.touches.length === 1) {
      e.preventDefault();
      pz.panBy(e.touches[0]!.clientX - touchX, e.touches[0]!.clientY - touchY);
      touchX = e.touches[0]!.clientX;
      touchY = e.touches[0]!.clientY;
      onChange();
    }
  }
  function onTouchEnd(e: TouchEvent): void {
    if (e.touches.length < 2) {
      pinching = false;
      prevDist = 0;
    }
    if (e.touches.length === 0) {
      touchPanning = false;
    }
  }

  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);
  el.addEventListener("touchstart", onTouchStart, { passive: false });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  el.addEventListener("touchend", onTouchEnd);

  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerUp);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/relay-web && npx vitest run src/__tests__/pan-zoom-gestures.test.ts`
Expected: PASS (5 tests). jsdom's `getBoundingClientRect` returns zeros, so origins are (0,0) — the assertions account for that.

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/relay-web && npx vue-tsc --noEmit && cd ../..
git add packages/relay-web/src/lib/pan-zoom-gestures.ts packages/relay-web/src/__tests__/pan-zoom-gestures.test.ts
git commit -m "feat(relay-web): shared pan/zoom gesture wiring (wheel/drag/pinch)"
```

---

### Task 3: `MermaidViewer.vue` — fullscreen overlay

**Files:**
- Create: `packages/relay-web/src/components/MermaidViewer.vue`
- Test: `packages/relay-web/src/__tests__/mermaidviewer.test.ts`

**Interfaces:**
- Consumes: `createPanZoom` (`../lib/pan-zoom`), `attachPanZoomGestures` (`../lib/pan-zoom-gestures`), `useModalA11y` (`../lib/use-modal-a11y`), icons from `lucide-vue-next`.
- Produces: component with prop `svg: string`, emit `close`. Rendered only while open (parent `v-if`).

- [ ] **Step 1: Write the failing tests**

Create `packages/relay-web/src/__tests__/mermaidviewer.test.ts`. NOTE: Teleport puts the overlay in `document.body`, so query there (NOT `wrapper.get`):
```ts
import { afterEach, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import MermaidViewer from "../components/MermaidViewer.vue";

const SVG = '<svg data-test="diagram"><text>hi</text></svg>';
afterEach(() => { document.body.innerHTML = ""; document.body.style.overflow = ""; });

const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
function fire(el: EventTarget, type: string, props: Record<string, unknown>): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, props);
  el.dispatchEvent(e);
}

test("teleports and renders the svg; locks body scroll while open", () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  expect(q('[data-test="diagram"]')).not.toBeNull();
  expect(document.body.style.overflow).toBe("hidden");
  wrapper.unmount();
  expect(document.body.style.overflow).toBe("");
});

test("wheel changes the transform; reset restores it", async () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  const content = q(".mv-content")!;
  const before = content.style.transform;
  fire(q(".mv-stage")!, "wheel", { deltaY: -100, clientX: 0, clientY: 0 });
  await wrapper.vm.$nextTick();
  expect(content.style.transform).not.toBe(before);
  q('[aria-label="Reset"]')!.click();
  await wrapper.vm.$nextTick();
  expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");
  wrapper.unmount();
});

test("Escape, close button, and background click each emit close", async () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  q('[aria-label="Close"]')!.click();
  q(".mv-stage")!.click(); // background (target === stage)
  await wrapper.vm.$nextTick();
  expect(wrapper.emitted("close")!.length).toBeGreaterThanOrEqual(3);
  wrapper.unmount();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/relay-web && npx vitest run src/__tests__/mermaidviewer.test.ts`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement `MermaidViewer.vue`**

Create `packages/relay-web/src/components/MermaidViewer.vue`:
```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { X, ZoomIn, ZoomOut, RotateCcw } from "lucide-vue-next";
import { createPanZoom } from "../lib/pan-zoom";
import { attachPanZoomGestures } from "../lib/pan-zoom-gestures";
import { useModalA11y } from "../lib/use-modal-a11y";

// Rendered only while open (parent v-if) → mount/unmount == open/close.
defineProps<{ svg: string }>();
const emit = defineEmits<{ close: [] }>();

const dialogEl = ref<HTMLElement | null>(null);
const stageEl = ref<HTMLElement | null>(null);
const transform = ref("translate(0px, 0px) scale(1)");
const pz = createPanZoom();
function apply(): void {
  transform.value = pz.toTransform();
}

useModalA11y(dialogEl, () => emit("close"));

let detach: (() => void) | null = null;
let prevOverflow = "";
onMounted(() => {
  if (stageEl.value) {
    detach = attachPanZoomGestures(stageEl.value, pz, apply, { oneFingerTouchPan: true });
  }
  prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
});
onBeforeUnmount(() => {
  detach?.();
  document.body.style.overflow = prevOverflow;
});

function zoomButton(factor: number): void {
  const r = stageEl.value?.getBoundingClientRect();
  pz.zoomAt(factor, r ? r.width / 2 : 0, r ? r.height / 2 : 0);
  apply();
}
function reset(): void {
  pz.reset();
  apply();
}
function onStageClick(e: MouseEvent): void {
  if (e.target === stageEl.value) emit("close"); // background, not the diagram
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="dialogEl"
      class="mermaid-viewer"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram viewer"
    >
      <div ref="stageEl" class="mv-stage" @click="onStageClick">
        <!-- eslint-disable-next-line vue/no-v-html -- SVG already DOMPurify-sanitized by render-mermaid -->
        <div class="mv-content" :style="{ transform }" v-html="svg" />
      </div>
      <div class="mv-controls">
        <button type="button" aria-label="Zoom out" @click="zoomButton(0.8)"><ZoomOut :size="18" /></button>
        <button type="button" aria-label="Reset" @click="reset()"><RotateCcw :size="18" /></button>
        <button type="button" aria-label="Zoom in" @click="zoomButton(1.25)"><ZoomIn :size="18" /></button>
        <button type="button" aria-label="Close" @click="emit('close')"><X :size="18" /></button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mermaid-viewer {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgb(var(--c-bg) / 0.92);
  backdrop-filter: blur(2px);
}
.mv-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}
.mv-stage:active {
  cursor: grabbing;
}
.mv-content {
  transform-origin: 0 0;
  width: max-content;
}
.mv-content :deep(svg) {
  display: block;
}
.mv-controls {
  position: absolute;
  top: calc(0.75rem + env(safe-area-inset-top));
  right: 0.75rem;
  display: flex;
  gap: 0.35rem;
}
.mv-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 8px;
  border: 1px solid rgb(var(--c-border));
  background: rgb(var(--c-surface));
  color: rgb(var(--c-fg));
  box-shadow: var(--shadow-e1);
}
.mv-controls button:hover {
  background: rgb(var(--c-bg-raised, var(--c-surface)));
}
</style>
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/relay-web && npx vitest run src/__tests__/mermaidviewer.test.ts && npx vue-tsc --noEmit`
Expected: PASS (3 tests) + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/components/MermaidViewer.vue packages/relay-web/src/__tests__/mermaidviewer.test.ts
git commit -m "feat(relay-web): fullscreen mermaid viewer with pan/zoom"
```

---

### Task 4: `inline-mermaid.ts` — in-place enhancement

**Files:**
- Create: `packages/relay-web/src/lib/inline-mermaid.ts`
- Test: `packages/relay-web/src/__tests__/inline-mermaid.test.ts`

**Interfaces:**
- Consumes: `createPanZoom`, `attachPanZoomGestures`.
- Produces: `enhanceMermaidBlock(block: HTMLElement, opts: { onExpand: () => void }): () => void`. Consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

Create `packages/relay-web/src/__tests__/inline-mermaid.test.ts`:
```ts
import { afterEach, expect, test } from "vitest";
import { enhanceMermaidBlock } from "../lib/inline-mermaid";

afterEach(() => { document.body.innerHTML = ""; });
function fire(el: EventTarget, type: string, props: Record<string, unknown>): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, props);
  el.dispatchEvent(e);
}
function makeBlock(): HTMLElement {
  const block = document.createElement("pre");
  block.className = "mermaid-block mermaid-rendered";
  block.innerHTML = '<svg data-test="d"><text>x</text></svg>';
  document.body.appendChild(block);
  return block;
}

test("wraps the svg in a viewport and adds a 4-button controls bar", () => {
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {} });
  expect(block.querySelector('.mmd-viewport .mmd-transform svg[data-test="d"]')).not.toBeNull();
  expect(block.querySelectorAll(".mmd-controls button").length).toBe(4);
});

test("Ctrl+wheel zooms; a plain wheel does not (page keeps scrolling)", () => {
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {} });
  const viewport = block.querySelector(".mmd-viewport")!;
  const wrap = block.querySelector(".mmd-transform") as HTMLElement;
  fire(viewport, "wheel", { deltaY: -100, clientX: 0, clientY: 0 });
  expect(wrap.style.transform === "" || wrap.style.transform === "translate(0px, 0px) scale(1)").toBe(true);
  fire(viewport, "wheel", { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
  expect(wrap.style.transform).toContain("scale(1.1)");
});

test("reset restores the transform; the ⤢ button calls onExpand", () => {
  let expanded = 0;
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => { expanded += 1; } });
  (block.querySelector('[aria-label="Zoom in"]') as HTMLElement).click();
  (block.querySelector('[aria-label="Reset"]') as HTMLElement).click();
  expect((block.querySelector(".mmd-transform") as HTMLElement).style.transform).toBe("translate(0px, 0px) scale(1)");
  (block.querySelector('[aria-label="Fullscreen"]') as HTMLElement).click();
  expect(expanded).toBe(1);
});

test("detach removes gesture listeners", () => {
  const block = makeBlock();
  const detach = enhanceMermaidBlock(block, { onExpand: () => {} });
  detach();
  const wrap = block.querySelector(".mmd-transform") as HTMLElement;
  const before = wrap.style.transform;
  fire(block.querySelector(".mmd-viewport")!, "wheel", { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
  expect(wrap.style.transform).toBe(before);
});

test("a block with no svg is a no-op returning a safe detach", () => {
  const block = document.createElement("pre");
  block.className = "mermaid-block mermaid-rendered";
  document.body.appendChild(block);
  const detach = enhanceMermaidBlock(block, { onExpand: () => {} });
  expect(block.querySelector(".mmd-viewport")).toBeNull();
  expect(() => detach()).not.toThrow();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/relay-web && npx vitest run src/__tests__/inline-mermaid.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `inline-mermaid.ts`**

Create `packages/relay-web/src/lib/inline-mermaid.ts`:
```ts
import { createPanZoom } from "./pan-zoom";
import { attachPanZoomGestures } from "./pan-zoom-gestures";

interface ZoomControl {
  label: string;
  glyph: string;
  factor: number; // 0 === reset
}
const ZOOM_CONTROLS: ZoomControl[] = [
  { label: "Zoom out", glyph: "−", factor: 0.8 }, // −
  { label: "Reset", glyph: "↺", factor: 0 }, // ↺
  { label: "Zoom in", glyph: "+", factor: 1.25 },
];

/**
 * Enhance a rendered `pre.mermaid-block`: move its injected `<svg>` into a bounded pan/zoom
 * viewport (Ctrl/⌘+wheel zoom, mouse-drag pan, two-finger pinch; one finger still scrolls the
 * page), and add a controls bar (− / reset / + / ⤢). The ⤢ button calls `onExpand`. Returns a
 * detach that removes every listener. A block without an `<svg>` is a no-op.
 */
export function enhanceMermaidBlock(block: HTMLElement, opts: { onExpand: () => void }): () => void {
  const svg = block.querySelector("svg");
  if (!svg) return () => {};

  const viewport = document.createElement("div");
  viewport.className = "mmd-viewport";
  const wrapper = document.createElement("div");
  wrapper.className = "mmd-transform";
  wrapper.appendChild(svg); // moves the svg out of the <pre>
  viewport.appendChild(wrapper);

  const pz = createPanZoom();
  const apply = (): void => {
    wrapper.style.transform = pz.toTransform();
  };

  const bar = document.createElement("div");
  bar.className = "mmd-controls";
  const buttonDetachers: Array<() => void> = [];

  const addButton = (label: string, glyph: string, handler: (e: Event) => void): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.textContent = glyph;
    b.addEventListener("click", handler);
    buttonDetachers.push(() => b.removeEventListener("click", handler));
    bar.appendChild(b);
  };

  for (const control of ZOOM_CONTROLS) {
    addButton(control.label, control.glyph, (e) => {
      e.stopPropagation();
      if (control.factor === 0) {
        pz.reset();
      } else {
        const r = viewport.getBoundingClientRect();
        pz.zoomAt(control.factor, r.width / 2, r.height / 2);
      }
      apply();
    });
  }
  addButton("Fullscreen", "⤢", (e) => {
    e.stopPropagation();
    opts.onExpand();
  });

  block.replaceChildren(viewport, bar);

  const detachGestures = attachPanZoomGestures(viewport, pz, apply, { wheelRequiresModifier: true });

  return () => {
    detachGestures();
    for (const d of buttonDetachers) d();
  };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/relay-web && npx vitest run src/__tests__/inline-mermaid.test.ts && npx vue-tsc --noEmit`
Expected: PASS (5 tests) + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/lib/inline-mermaid.ts packages/relay-web/src/__tests__/inline-mermaid.test.ts
git commit -m "feat(relay-web): inline pan/zoom enhancement for rendered mermaid blocks"
```

---

### Task 5: Wire inline + fullscreen into `StreamMarkdown` (+ CSS + docs)

**Files:**
- Modify: `packages/relay-web/src/components/StreamMarkdown.vue`
- Test: `packages/relay-web/src/__tests__/streammarkdown.test.ts` (add cases)
- Modify: `docs/relay-web-module.md`

**Interfaces:**
- Consumes: `enhanceMermaidBlock` (`../lib/inline-mermaid`), `MermaidViewer.vue`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/relay-web/src/__tests__/streammarkdown.test.ts`. The existing file mocks `../lib/render-mermaid` with a `hydrate` `vi.fn`. For these cases, give that mock a body that marks blocks rendered and injects an svg, so there is a rendered block to enhance:
```ts
import MermaidViewer from "../components/MermaidViewer.vue";

// In a test that needs a rendered block, set the shared hydrate mock to actually render:
//   hydrate.mockImplementation(async (root: HTMLElement) => {
//     root.querySelectorAll("pre.mermaid-block").forEach((b) => {
//       b.classList.add("mermaid-rendered");
//       b.innerHTML = '<svg data-test="d"><text>x</text></svg>';
//     });
//   });

test("a rendered mermaid block is enhanced with an inline pan/zoom viewport + controls", async () => {
  hydrate.mockImplementation(async (root: HTMLElement) => {
    root.querySelectorAll("pre.mermaid-block").forEach((b) => {
      b.classList.add("mermaid-rendered");
      b.innerHTML = '<svg data-test="d"><text>x</text></svg>';
    });
  });
  const wrapper = mount(StreamMarkdown, {
    props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false },
    global: { stubs: { MermaidViewer: true } },
  });
  await nextTick();
  await nextTick();
  expect(wrapper.element.querySelector(".mmd-viewport")).not.toBeNull();
  expect(wrapper.element.querySelectorAll(".mmd-controls button").length).toBe(4);
  // idempotent: a second hydrate pass must not double-enhance
  await wrapper.setProps({ streaming: false });
  await nextTick();
  expect(wrapper.element.querySelectorAll(".mmd-viewport").length).toBe(1);
  hydrate.mockImplementation(async () => {});
  wrapper.unmount();
});

test("clicking the ⤢ button opens the fullscreen viewer with the diagram svg", async () => {
  hydrate.mockImplementation(async (root: HTMLElement) => {
    root.querySelectorAll("pre.mermaid-block").forEach((b) => {
      b.classList.add("mermaid-rendered");
      b.innerHTML = '<svg data-test="d"><text>x</text></svg>';
    });
  });
  const wrapper = mount(StreamMarkdown, {
    props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false },
    global: { stubs: { MermaidViewer: true } },
  });
  await nextTick();
  await nextTick();
  expect(wrapper.findComponent(MermaidViewer).exists()).toBe(false);
  (wrapper.element.querySelector('[aria-label="Fullscreen"]') as HTMLElement).click();
  await nextTick();
  const viewer = wrapper.findComponent(MermaidViewer);
  expect(viewer.exists()).toBe(true);
  expect(viewer.props("svg")).toContain('data-test="d"');
  hydrate.mockImplementation(async () => {});
  wrapper.unmount();
});
```
(Keep the pre-existing streammarkdown tests working: they rely on `hydrate` being a `vi.fn` — restore `hydrate.mockImplementation(async () => {})` at the end of each new test, or set it in a `beforeEach`. If the shared mock isn't a resettable `vi.fn`, adapt to whatever the file already uses; the key is that the default hydrate does nothing so the streaming/theme tests are unaffected.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/relay-web && npx vitest run src/__tests__/streammarkdown.test.ts`
Expected: FAIL — StreamMarkdown does not enhance blocks or render the viewer.

- [ ] **Step 3: Wire `StreamMarkdown.vue`**

Add imports:
```ts
import { enhanceMermaidBlock } from "../lib/inline-mermaid";
import MermaidViewer from "./MermaidViewer.vue";
```
Add state + helpers near the other refs (after `let hydrateChain`):
```ts
const viewerSvg = ref<string | null>(null);
let enhanceDetachers: Array<() => void> = [];
function detachEnhancers(): void {
  for (const d of enhanceDetachers) d();
  enhanceDetachers = [];
}
// After hydration, give each freshly-rendered diagram inline pan/zoom + a ⤢ that opens the
// fullscreen viewer. `data-mmd-enhanced` keeps a re-hydration from wrapping the same block twice.
function enhanceRenderedBlocks(root: HTMLElement): void {
  root
    .querySelectorAll<HTMLElement>("pre.mermaid-block.mermaid-rendered:not([data-mmd-enhanced])")
    .forEach((block) => {
      block.setAttribute("data-mmd-enhanced", "1");
      enhanceDetachers.push(
        enhanceMermaidBlock(block, {
          onExpand: () => {
            viewerSvg.value = block.querySelector("svg")?.outerHTML ?? null;
          },
        }),
      );
    });
}
```
Change `scheduleHydrate` to detach enhancers on reset and enhance after hydration:
```ts
function scheduleHydrate(reset: boolean): void {
  if (props.streaming) return;
  hydrateChain = hydrateChain
    .then(async () => {
      await nextTick();
      if (disposed || rootEl.value === null) return;
      if (reset) {
        detachEnhancers();
        resetMermaidBlocks(rootEl.value);
      }
      await hydrateMermaidBlocks(rootEl.value, theme.mode);
      if (!disposed && rootEl.value !== null) enhanceRenderedBlocks(rootEl.value);
    })
    .catch(() => {});
}
```
Extend the unmount hook to detach enhancers:
```ts
onBeforeUnmount(() => {
  disposed = true;
  cancelTimer();
  detachEnhancers();
});
```
(If the existing `onBeforeUnmount` only calls `cancelTimer()`, add `detachEnhancers()` and keep the `disposed = true` that is already there.)

Update the template to render the viewer (the root `<div>` stays exactly as-is):
```html
<template>
  <!-- eslint-disable-next-line vue/no-v-html -- input is sanitized by renderMarkdown (DOMPurify) -->
  <div ref="rootEl" class="stream-md text-sm" v-html="html" />
  <MermaidViewer v-if="viewerSvg" :svg="viewerSvg" @close="viewerSvg = null" />
</template>
```

- [ ] **Step 4: Add inline CSS to the same file's non-scoped `<style>`**

Append after the `.mermaid-error` rule:
```css
/* Inline pan/zoom: the enhancer replaces the rendered <pre> content with a bounded viewport + a
   controls bar. The <pre> is the positioning context for the controls. */
.stream-md .mermaid-block.mermaid-rendered {
  position: relative;
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  overflow: visible;
}
.stream-md .mmd-viewport {
  max-height: 420px;
  overflow: hidden;
  border: 1px solid rgb(var(--c-border));
  border-radius: 8px;
  background: rgb(var(--c-bg));
  box-shadow: var(--shadow-e1);
  touch-action: pan-y; /* one finger scrolls the page; the enhancer handles pinch + mouse drag */
  cursor: grab;
}
.stream-md .mmd-viewport:active {
  cursor: grabbing;
}
.stream-md .mmd-transform {
  transform-origin: 0 0;
  width: max-content;
}
.stream-md .mmd-transform svg {
  display: block;
}
.stream-md .mmd-controls {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  opacity: 0.5;
  transition: opacity 0.12s;
}
.stream-md .mermaid-block.mermaid-rendered:hover .mmd-controls,
.stream-md .mermaid-block.mermaid-rendered:focus-within .mmd-controls {
  opacity: 1;
}
.stream-md .mmd-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  font-size: 14px;
  line-height: 1;
  border-radius: 6px;
  border: 1px solid rgb(var(--c-border));
  background: rgb(var(--c-surface));
  color: rgb(var(--c-fg));
}
.stream-md .mmd-controls button:hover {
  background: rgb(var(--c-bg-raised, var(--c-surface)));
}
```

- [ ] **Step 5: Run the full relay-web suite + typecheck**

Run: `cd packages/relay-web && npx vitest run && npx vue-tsc --noEmit`
Expected: new cases pass; all pre-existing tests still pass; typecheck clean.

- [ ] **Step 6: Document it**

In `docs/relay-web-module.md`, extend the `### Mermaid 图表渲染` subsection with:
```markdown
已渲染的图表支持平移/缩放：**内联**（`inline-mermaid.ts` 就地增强——Ctrl/⌘+滚轮缩放、鼠标拖拽平移、
双指捏合；单指仍滚动页面）配一条 − / 复位 / + / ⤢ 控件条；点 ⤢ 打开**全屏**查看器（`MermaidViewer.vue`，
平滑滚轮/单指拖拽/双指缩放 + Esc/✕/点空白关闭）。两种模式共用纯 `pan-zoom.ts` 控制器与
`pan-zoom-gestures.ts` 手势装配；均复用已注入 DOM 的（已净化）SVG，不重新解析。
```

- [ ] **Step 7: Commit**

```bash
git add packages/relay-web/src/components/StreamMarkdown.vue packages/relay-web/src/__tests__/streammarkdown.test.ts docs/relay-web-module.md
git commit -m "feat(relay-web): inline + fullscreen pan/zoom for mermaid diagrams"
```

---

## Self-Review

**Spec coverage:** gestures module (Task 2) ✓; fullscreen viewer (Task 3) ✓; inline enhancer (Task 4) ✓; StreamMarkdown wiring both modes + CSS + docs (Task 5) ✓. `pan-zoom.ts` (Task 1) already done.

**Placeholder scan:** every code step has complete code; no TBD.

**Type consistency:** `attachPanZoomGestures(el, pz, onChange, opts?)` and `GestureOptions` identical across Task 2 (def), Task 3, Task 4. `PanZoom` from `pan-zoom.ts` consumed unchanged. `enhanceMermaidBlock(block, { onExpand })` identical in Task 4 (def) and Task 5 (call). `MermaidViewer` prop `svg: string` / emit `close` identical in Task 3 and Task 5. The enhancer/viewer select `pre.mermaid-block.mermaid-rendered` — the class `render-mermaid` sets on success.
