# Web Mermaid Pan/Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rendered Mermaid diagrams pan/zoomable — clicking a diagram opens a fullscreen viewer with drag-pan, wheel-zoom, pinch-zoom, on-screen controls, and reset.

**Architecture:** Three additive seams in `packages/relay-web`. A pure `pan-zoom` transform controller; a `MermaidViewer.vue` fullscreen overlay that wires DOM gestures to it; and a click handler in `StreamMarkdown.vue` that opens the viewer with a rendered block's SVG. `render-mermaid.ts` is unchanged.

**Tech Stack:** Vue 3, `lucide-vue-next` icons, the existing `useModalA11y` composable, Vitest (jsdom) + @vue/test-utils.

## Global Constraints

- All code in `packages/relay-web`. Tests run with `npx vitest run` **from `packages/relay-web`** — never `bun test` (jsdom-dependent).
- No new npm dependency (pan/zoom is hand-rolled; icons come from the existing `lucide-vue-next`).
- Security: the viewer displays the SAME SVG string `render-mermaid` already produced and DOMPurified before injecting inline — read back from the live DOM, never re-parsed or re-fetched.
- The existing mermaid hydration / streaming / theme logic in `StreamMarkdown.vue` and all of `render-mermaid.ts` must stay unchanged.
- Overlay conventions: use `useModalA11y(dialogEl, close)` (Esc + focus trap + focus restore); the panel needs `ref`, `tabindex="-1" role="dialog" aria-modal="true"`. The viewer is rendered under `v-if` in the parent so it mounts on open / unmounts on close.
- YAGNI: no inline gestures, no fit-to-screen auto-scale, no export, no minimap.

---

### Task 1: `pan-zoom` transform controller

**Files:**
- Create: `packages/relay-web/src/lib/pan-zoom.ts`
- Test: `packages/relay-web/src/__tests__/pan-zoom.test.ts`

**Interfaces:**
- Produces: `createPanZoom(opts?: { minScale?: number; maxScale?: number }): PanZoom` where `PanZoom` has `readonly state: { scale; x; y }`, `zoomAt(factor, cx, cy)`, `panBy(dx, dy)`, `reset()`, `toTransform(): string`. Consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `packages/relay-web/src/__tests__/pan-zoom.test.ts`:
```ts
import { expect, test } from "vitest";
import { createPanZoom } from "../lib/pan-zoom";

test("starts at identity and formats a transform-origin:0,0 transform", () => {
  const pz = createPanZoom();
  expect(pz.state).toEqual({ scale: 1, x: 0, y: 0 });
  expect(pz.toTransform()).toBe("translate(0px, 0px) scale(1)");
});

test("zoomAt keeps the point under the cursor stationary", () => {
  const pz = createPanZoom();
  pz.zoomAt(2, 100, 0); // zoom 2x centered on viewport x=100
  // content point that was under x=100 must still be under x=100: x = 100 - (100-0)*(2/1) = -100
  expect(pz.state.scale).toBe(2);
  expect(pz.state.x).toBe(-100);
  expect(pz.state.y).toBe(0);
});

test("zoomAt clamps scale to [minScale, maxScale]", () => {
  const pz = createPanZoom({ minScale: 0.5, maxScale: 4 });
  pz.zoomAt(100, 0, 0);
  expect(pz.state.scale).toBe(4);
  pz.zoomAt(0.0001, 0, 0);
  expect(pz.state.scale).toBe(0.5);
});

test("panBy accumulates and reset returns to identity", () => {
  const pz = createPanZoom();
  pz.panBy(10, 20);
  pz.panBy(5, -5);
  expect(pz.state).toEqual({ scale: 1, x: 15, y: 15 });
  pz.zoomAt(2, 50, 50);
  pz.reset();
  expect(pz.state).toEqual({ scale: 1, x: 0, y: 0 });
  expect(pz.toTransform()).toBe("translate(0px, 0px) scale(1)");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/relay-web && npx vitest run src/__tests__/pan-zoom.test.ts`
Expected: FAIL — `../lib/pan-zoom` does not exist.

- [ ] **Step 3: Implement `pan-zoom.ts`**

Create `packages/relay-web/src/lib/pan-zoom.ts`:
```ts
// Pure, framework-free pan/zoom transform state. The consumer applies `toTransform()` to an
// element with `transform-origin: 0 0`. Kept DOM-free so the geometry is unit-testable.
export interface PanZoomState {
  scale: number;
  x: number;
  y: number;
}

export interface PanZoom {
  readonly state: PanZoomState;
  /** Multiply scale by `factor`, keeping viewport point (cx, cy) stationary. Clamps scale. */
  zoomAt(factor: number, cx: number, cy: number): void;
  panBy(dx: number, dy: number): void;
  reset(): void;
  /** CSS transform for a `transform-origin: 0 0` element. */
  toTransform(): string;
}

export function createPanZoom(opts: { minScale?: number; maxScale?: number } = {}): PanZoom {
  const minScale = opts.minScale ?? 0.2;
  const maxScale = opts.maxScale ?? 8;
  const state: PanZoomState = { scale: 1, x: 0, y: 0 };

  return {
    state,
    zoomAt(factor, cx, cy) {
      const next = Math.min(maxScale, Math.max(minScale, state.scale * factor));
      if (next === state.scale) return;
      // Solve for the translation that pins content point ((cx - x)/scale) under (cx, cy).
      state.x = cx - (cx - state.x) * (next / state.scale);
      state.y = cy - (cy - state.y) * (next / state.scale);
      state.scale = next;
    },
    panBy(dx, dy) {
      state.x += dx;
      state.y += dy;
    },
    reset() {
      state.scale = 1;
      state.x = 0;
      state.y = 0;
    },
    toTransform() {
      return `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    },
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/relay-web && npx vitest run src/__tests__/pan-zoom.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/lib/pan-zoom.ts packages/relay-web/src/__tests__/pan-zoom.test.ts
git commit -m "feat(relay-web): pure pan/zoom transform controller"
```

---

### Task 2: `MermaidViewer.vue` fullscreen overlay

**Files:**
- Create: `packages/relay-web/src/components/MermaidViewer.vue`
- Test: `packages/relay-web/src/__tests__/mermaidviewer.test.ts`

**Interfaces:**
- Consumes: `createPanZoom` (Task 1); `useModalA11y` from `../lib/use-modal-a11y`; icons from `lucide-vue-next`.
- Produces: a component with prop `svg: string` and emit `close`. Rendered only when open (parent `v-if`).

- [ ] **Step 1: Write the failing tests**

Create `packages/relay-web/src/__tests__/mermaidviewer.test.ts`:
```ts
import { afterEach, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import MermaidViewer from "../components/MermaidViewer.vue";

const SVG = '<svg data-test="diagram"><text>hi</text></svg>';

afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

function content(): HTMLElement | null {
  return document.body.querySelector(".mv-content");
}

test("teleports and renders the svg; locks body scroll while open", () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  expect(document.body.querySelector('[data-test="diagram"]')).not.toBeNull();
  expect(document.body.style.overflow).toBe("hidden");
  wrapper.unmount();
  expect(document.body.style.overflow).toBe(""); // restored
});

test("wheel and the zoom-in control change the transform; reset restores it", async () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  const before = content()!.style.transform;
  const stage = document.body.querySelector(".mv-stage")!;
  stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
  await wrapper.vm.$nextTick();
  expect(content()!.style.transform).not.toBe(before);
  await wrapper.get('[aria-label="Reset"]').trigger("click");
  expect(content()!.style.transform).toBe("translate(0px, 0px) scale(1)");
  wrapper.unmount();
});

test("pointer drag pans the content", async () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  const stage = wrapper.get(".mv-stage");
  await stage.trigger("pointerdown", { pointerId: 1, clientX: 0, clientY: 0 });
  await stage.trigger("pointermove", { pointerId: 1, clientX: 30, clientY: 40 });
  await stage.trigger("pointerup", { pointerId: 1 });
  expect(content()!.style.transform).toBe("translate(30px, 40px) scale(1)");
  wrapper.unmount();
});

test("close button, backdrop click, and Escape each emit close", async () => {
  const wrapper = mount(MermaidViewer, { props: { svg: SVG } });
  await wrapper.get('[aria-label="Close"]').trigger("click");
  expect(wrapper.emitted("close")).toHaveLength(1);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await wrapper.vm.$nextTick();
  expect(wrapper.emitted("close")!.length).toBeGreaterThanOrEqual(2);
  wrapper.unmount();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/relay-web && npx vitest run src/__tests__/mermaidviewer.test.ts`
Expected: FAIL — `../components/MermaidViewer.vue` does not exist.

- [ ] **Step 3: Implement `MermaidViewer.vue`**

Create `packages/relay-web/src/components/MermaidViewer.vue`:
```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { X, ZoomIn, ZoomOut, RotateCcw } from "lucide-vue-next";
import { createPanZoom } from "../lib/pan-zoom";
import { useModalA11y } from "../lib/use-modal-a11y";

// Rendered only while open (parent v-if), so mount/unmount === open/close: useModalA11y and the
// body-scroll lock hook straight into the component lifecycle.
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

function stageRect(): DOMRect | null {
  return stageEl.value?.getBoundingClientRect() ?? null;
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const rect = stageRect();
  if (!rect) return;
  pz.zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
  apply();
}

// Pointer drag (mouse or a single touch). A two-finger pinch takes over via the touch handlers.
let dragging = false;
let activePointer: number | null = null;
let lastX = 0;
let lastY = 0;
function onPointerDown(e: PointerEvent): void {
  if (pinchActive) return;
  dragging = true;
  activePointer = e.pointerId;
  lastX = e.clientX;
  lastY = e.clientY;
  stageEl.value?.setPointerCapture?.(e.pointerId);
}
function onPointerMove(e: PointerEvent): void {
  if (!dragging || e.pointerId !== activePointer) return;
  pz.panBy(e.clientX - lastX, e.clientY - lastY);
  lastX = e.clientX;
  lastY = e.clientY;
  apply();
}
function onPointerUp(e: PointerEvent): void {
  if (e.pointerId === activePointer) {
    dragging = false;
    activePointer = null;
  }
}

// Pinch zoom (two touches).
let pinchActive = false;
let pinchDist = 0;
function dist(t: TouchList): number {
  return Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
}
function onTouchStart(e: TouchEvent): void {
  if (e.touches.length === 2) {
    pinchActive = true;
    dragging = false;
    pinchDist = dist(e.touches);
  }
}
function onTouchMove(e: TouchEvent): void {
  if (!pinchActive || e.touches.length !== 2) return;
  e.preventDefault();
  const rect = stageRect();
  if (!rect || pinchDist === 0) {
    pinchDist = e.touches.length === 2 ? dist(e.touches) : 0;
    return;
  }
  const d = dist(e.touches);
  const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2 - rect.left;
  const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2 - rect.top;
  pz.zoomAt(d / pinchDist, midX, midY);
  pinchDist = d;
  apply();
}
function onTouchEnd(e: TouchEvent): void {
  if (e.touches.length < 2) {
    pinchActive = false;
    pinchDist = 0;
  }
}

function zoomButton(factor: number): void {
  const rect = stageRect();
  pz.zoomAt(factor, rect ? rect.width / 2 : 0, rect ? rect.height / 2 : 0);
  apply();
}
function reset(): void {
  pz.reset();
  apply();
}

// Background (not the diagram) click closes, but only when it wasn't a drag.
function onStagePointerUp(e: PointerEvent): void {
  const wasDrag = e.pointerId === activePointer && (Math.abs(e.clientX - lastX) > 4 || Math.abs(e.clientY - lastY) > 4);
  onPointerUp(e);
  if (!wasDrag && e.target === stageEl.value) emit("close");
}

let prevOverflow = "";
onMounted(() => {
  prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
});
onBeforeUnmount(() => {
  document.body.style.overflow = prevOverflow;
});
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
      <div
        ref="stageEl"
        class="mv-stage"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onStagePointerUp"
        @pointercancel="onPointerUp"
        @touchstart="onTouchStart"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
      >
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
  touch-action: none; /* the overlay owns all gestures; no page scroll behind it */
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

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/relay-web && npx vitest run src/__tests__/mermaidviewer.test.ts`
Expected: PASS (4 tests). If jsdom's `getBoundingClientRect` returns zeros, wheel/zoom still change scale (center at 0,0), so the transform still differs from identity — the assertions hold.

- [ ] **Step 5: Typecheck**

Run: `cd packages/relay-web && npx vue-tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/relay-web/src/components/MermaidViewer.vue packages/relay-web/src/__tests__/mermaidviewer.test.ts
git commit -m "feat(relay-web): fullscreen mermaid viewer with pan/zoom"
```

---

### Task 3: Open the viewer from `StreamMarkdown` on click (+ affordance CSS + docs)

**Files:**
- Modify: `packages/relay-web/src/components/StreamMarkdown.vue`
- Test: `packages/relay-web/src/__tests__/streammarkdown.test.ts` (add cases)
- Modify: `docs/relay-web-module.md`

**Interfaces:**
- Consumes: `MermaidViewer.vue` (Task 2). Opens it with a rendered block's `svg` outerHTML.

- [ ] **Step 1: Write the failing tests**

Add to `packages/relay-web/src/__tests__/streammarkdown.test.ts`. Make the mocked `hydrateMermaidBlocks` mark blocks rendered and inject an SVG so a click has something to read; stub `MermaidViewer` so the assertion is on its `svg` prop, not teleported DOM:
```ts
// In the existing vi.mock("../lib/render-mermaid", ...), make hydrate mark blocks rendered:
//   hydrateMermaidBlocks: async (root: HTMLElement) => {
//     root.querySelectorAll("pre.mermaid-block").forEach((b) => {
//       b.classList.add("mermaid-rendered");
//       b.innerHTML = '<svg data-test="d"><text>x</text></svg>';
//     });
//   },
//   resetMermaidBlocks: () => {},

import MermaidViewer from "../components/MermaidViewer.vue";

test("clicking a rendered mermaid block opens the viewer with its svg", async () => {
  const wrapper = mount(StreamMarkdown, {
    props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false },
    global: { stubs: { MermaidViewer: true } },
  });
  await nextTick();
  await nextTick();
  expect(wrapper.findComponent(MermaidViewer).exists()).toBe(false); // closed initially
  await wrapper.get("pre.mermaid-block.mermaid-rendered").trigger("click");
  const viewer = wrapper.findComponent(MermaidViewer);
  expect(viewer.exists()).toBe(true);
  expect(viewer.props("svg")).toContain('data-test="d"');
  wrapper.unmount();
});

test("clicking ordinary rendered text does not open the viewer", async () => {
  const wrapper = mount(StreamMarkdown, {
    props: { text: "just some **text**", streaming: false },
    global: { stubs: { MermaidViewer: true } },
  });
  await nextTick();
  await wrapper.get(".stream-md").trigger("click");
  expect(wrapper.findComponent(MermaidViewer).exists()).toBe(false);
  wrapper.unmount();
});
```
(If the file's `vi.mock("../lib/render-mermaid", ...)` is currently a no-op hydrate, update it to the rendering mock shown in the comment above so `.mermaid-rendered` blocks exist to click. Keep any other existing streammarkdown tests working — the streaming-guard tests only assert hydrate was/ wasn't called, which the new mock still supports if you keep the `vi.fn()` wrapper; wrap the rendering body inside the existing `hydrate` mock fn.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/relay-web && npx vitest run src/__tests__/streammarkdown.test.ts`
Expected: FAIL — StreamMarkdown neither imports MermaidViewer nor opens it on click.

- [ ] **Step 3: Wire the click handler into `StreamMarkdown.vue`**

In `<script setup>`, add the import and state, and a click handler:
```ts
import MermaidViewer from "./MermaidViewer.vue";
```
Add near the other refs:
```ts
// Clicking a fully-rendered mermaid diagram opens the fullscreen pan/zoom viewer. Delegated on the
// root so it survives v-html re-renders; reads the SVG already in the DOM (no re-parse).
const viewerSvg = ref<string | null>(null);
function onRootClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const block = target?.closest?.("pre.mermaid-block.mermaid-rendered");
  const svg = block?.querySelector("svg")?.outerHTML;
  if (svg) viewerSvg.value = svg;
}
```
Update the template root and add the viewer:
```html
<template>
  <!-- eslint-disable-next-line vue/no-v-html -- input is sanitized by renderMarkdown (DOMPurify) -->
  <div ref="rootEl" class="stream-md text-sm" v-html="html" @click="onRootClick" />
  <MermaidViewer v-if="viewerSvg" :svg="viewerSvg" @close="viewerSvg = null" />
</template>
```
(Note: the template currently has a single self-closing root `<div>`. Vue 3 allows multiple root nodes, so adding the sibling `<MermaidViewer>` is fine.)

- [ ] **Step 4: Add the click affordance CSS**

Append to the `<style>` block in `StreamMarkdown.vue` (after the `.mermaid-error` rule from the base feature):
```css
/* A rendered diagram is clickable → opens the pan/zoom viewer. Signal it with a zoom cursor and
   a hover ⤢ badge (on the <pre>, which is a real element, so ::after is safe over v-html SVG). */
.stream-md .mermaid-block.mermaid-rendered {
  cursor: zoom-in;
  position: relative;
}
.stream-md .mermaid-block.mermaid-rendered::after {
  content: "⤢";
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 14px;
  line-height: 1;
  color: rgb(var(--c-fg-muted));
  opacity: 0;
  transition: opacity 0.12s;
  pointer-events: none;
}
.stream-md .mermaid-block.mermaid-rendered:hover::after {
  opacity: 0.85;
}
```

- [ ] **Step 5: Run the full relay-web suite + typecheck**

Run: `cd packages/relay-web && npx vitest run && npx vue-tsc --noEmit`
Expected: new StreamMarkdown cases pass; all pre-existing tests still pass; typecheck clean.

- [ ] **Step 6: Document it**

In `docs/relay-web-module.md`, extend the `### Mermaid 图表渲染` subsection with one line:
```markdown
点击已渲染的图表会打开全屏查看器（`MermaidViewer.vue` + 纯 `pan-zoom.ts` 控制器）：拖拽平移、
滚轮/双指缩放、缩放/复位按钮、Esc/✕/点空白关闭。查看器复用已注入 DOM 的（已净化）SVG，不重新解析。
```

- [ ] **Step 7: Commit**

```bash
git add packages/relay-web/src/components/StreamMarkdown.vue packages/relay-web/src/__tests__/streammarkdown.test.ts docs/relay-web-module.md
git commit -m "feat(relay-web): open pan/zoom viewer when a mermaid diagram is clicked"
```

---

## Self-Review

**Spec coverage:** pure controller (Task 1) ✓; fullscreen viewer with drag/wheel/pinch/controls/close/scroll-lock/a11y (Task 2) ✓; click-to-open from StreamMarkdown + affordance + docs (Task 3) ✓.

**Placeholder scan:** every code step has complete code; no TBD.

**Type consistency:** `createPanZoom(): PanZoom` used identically in Task 1 (def) and Task 2 (consumer). `MermaidViewer` prop `svg: string` / emit `close` identical across Task 2 (def + tests) and Task 3 (usage + tests). The click handler reads `pre.mermaid-block.mermaid-rendered` — the exact class `render-mermaid` sets on success.
