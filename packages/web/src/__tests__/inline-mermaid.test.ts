import { afterEach, expect, test } from "vitest";
import { enhanceMermaidBlock } from "../lib/inline-mermaid";
import { encodeMermaidSource } from "../lib/mermaid-source";

// The enhancer takes its button text from the caller (it has no i18n of its own); these mirror the
// en catalog so the aria-label selectors below read naturally.
const LABELS = {
  zoomOut: "Zoom out",
  reset: "Reset",
  zoomIn: "Zoom in",
  fullscreen: "Fullscreen",
  source: "Show diagram source",
  download: "Download as PNG",
};
const SOURCE = "graph TD\n  A --> B";

afterEach(() => { document.body.innerHTML = ""; });
function fire(el: EventTarget, type: string, props: Record<string, unknown>): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, props);
  el.dispatchEvent(e);
}
function makeBlock(): HTMLElement {
  const block = document.createElement("pre");
  block.className = "mermaid-block mermaid-rendered";
  block.setAttribute("data-mermaid", encodeMermaidSource(SOURCE));
  block.innerHTML = '<svg data-test="d"><text>x</text></svg>';
  document.body.appendChild(block);
  return block;
}

test("wraps the svg in a viewport and adds a 6-button controls bar", () => {
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
  expect(block.querySelector('.mmd-viewport .mmd-transform svg[data-test="d"]')).not.toBeNull();
  expect(block.querySelectorAll(".mmd-controls button").length).toBe(6);
});

test("Ctrl+wheel zooms; a plain wheel does not (page keeps scrolling)", () => {
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
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
  enhanceMermaidBlock(block, { onExpand: () => { expanded += 1; }, labels: LABELS });
  (block.querySelector('[aria-label="Zoom in"]') as HTMLElement).click();
  (block.querySelector('[aria-label="Reset"]') as HTMLElement).click();
  expect((block.querySelector(".mmd-transform") as HTMLElement).style.transform).toBe("translate(0px, 0px) scale(1)");
  (block.querySelector('[aria-label="Fullscreen"]') as HTMLElement).click();
  expect(expanded).toBe(1);
});

test("detach removes gesture listeners", () => {
  const block = makeBlock();
  const detach = enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
  detach();
  const wrap = block.querySelector(".mmd-transform") as HTMLElement;
  const before = wrap.style.transform;
  fire(block.querySelector(".mmd-viewport")!, "wheel", { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
  expect(wrap.style.transform).toBe(before);
});

test("fits a measurable diagram: scales down to the container width, centers, sizes the viewport", () => {
  const block = document.createElement("pre");
  block.className = "mermaid-block mermaid-rendered";
  block.setAttribute("data-mermaid", encodeMermaidSource(SOURCE));
  block.innerHTML = '<svg data-test="d"><text>x</text></svg>';
  document.body.appendChild(block);
  // jsdom returns zeros for layout; stub the diagram's intrinsic size (400×200, wider than the
  // 100px container → must scale to 0.25) and the viewport width.
  const svg = block.querySelector("svg")!;
  svg.getBoundingClientRect = () =>
    ({ width: 400, height: 200, x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 200, toJSON() {} }) as DOMRect;
  const had = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientWidth");
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 100 });
  try {
    enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
    const wrap = block.querySelector(".mmd-transform") as HTMLElement;
    const viewport = block.querySelector(".mmd-viewport") as HTMLElement;
    // 100/400 = 0.25; centered x = (100 - 400*0.25)/2 = 0; viewport height = 200 * 0.25 = 50.
    expect(wrap.style.transform).toBe("translate(0px, 0px) scale(0.25)");
    expect(viewport.style.height).toBe("50px");
    // Reset returns to that fitted home, not 1×.
    (block.querySelector('[aria-label="Zoom in"]') as HTMLElement).click();
    (block.querySelector('[aria-label="Reset"]') as HTMLElement).click();
    expect(wrap.style.transform).toBe("translate(0px, 0px) scale(0.25)");
  } finally {
    if (had) Object.defineProperty(window.HTMLElement.prototype, "clientWidth", had);
    else delete (window.HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  }
});

test("re-fits on a container WIDTH change while at home, but never after the user zooms", () => {
  const block = document.createElement("pre");
  block.className = "mermaid-block mermaid-rendered";
  block.setAttribute("data-mermaid", encodeMermaidSource(SOURCE));
  block.innerHTML = '<svg data-test="d"><text>x</text></svg>';
  document.body.appendChild(block);
  const svg = block.querySelector("svg")!;
  svg.getBoundingClientRect = () =>
    ({ width: 400, height: 200, x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 200, toJSON() {} }) as DOMRect;
  // Controllable ResizeObserver: capture the callback so the test can fire it deterministically
  // (the global test stub never fires it).
  let roCb: () => void = () => {}; // reassigned by the ResizeObserver ctor below
  const RealRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(cb: () => void) { roCb = cb; }
    observe(): void {} unobserve(): void {} disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  let width = 100;
  const had = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientWidth");
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  try {
    enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
    const wrap = block.querySelector(".mmd-transform") as HTMLElement;
    expect(wrap.style.transform).toContain("scale(0.25)"); // 100/400

    width = 200; // container widened
    roCb();
    expect(wrap.style.transform).toContain("scale(0.5)"); // re-fit while at home: 200/400

    // User zooms in → no longer at home. A further resize must NOT yank their view.
    (block.querySelector('[aria-label="Zoom in"]') as HTMLElement).click();
    const zoomed = wrap.style.transform;
    width = 400;
    roCb();
    expect(wrap.style.transform).toBe(zoomed); // unchanged — atHome guard held
  } finally {
    if (had) Object.defineProperty(window.HTMLElement.prototype, "clientWidth", had);
    else delete (window.HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    globalThis.ResizeObserver = RealRO;
  }
});

test("a block with no svg is a no-op returning a safe detach", () => {
  const block = document.createElement("pre");
  block.className = "mermaid-block mermaid-rendered";
  document.body.appendChild(block);
  const detach = enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
  expect(block.querySelector(".mmd-viewport")).toBeNull();
  expect(() => detach()).not.toThrow();
});

test("the </> button toggles source mode, tracks aria-pressed, and renders the decoded source", () => {
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
  const toggle = block.querySelector('[aria-label="Show diagram source"]') as HTMLElement;

  // The source is decoded from data-mermaid (the source of truth) — the <code> fallback is gone
  // once the block is hydrated.
  expect((block.querySelector("pre.mmd-source code") as HTMLElement).textContent).toBe(SOURCE);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(block.classList.contains("mmd-source-mode")).toBe(false);

  toggle.click();
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(block.classList.contains("mmd-source-mode")).toBe(true);

  toggle.click(); // and back
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(block.classList.contains("mmd-source-mode")).toBe(false);
});

test("zoom/reset/fullscreen are view-only (hidden in source mode); </> and ⬇ are not", () => {
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
  const viewOnly = (label: string): boolean =>
    (block.querySelector(`[aria-label="${label}"]`) as HTMLElement).classList.contains("mmd-view-only");
  for (const label of ["Zoom out", "Reset", "Zoom in", "Fullscreen"]) expect(viewOnly(label)).toBe(true);
  for (const label of ["Show diagram source", "Download as PNG"]) expect(viewOnly(label)).toBe(false);
});

test("a block with an empty/absent data-mermaid still enhances, with an empty source view", () => {
  const block = document.createElement("pre");
  block.className = "mermaid-block mermaid-rendered";
  block.innerHTML = '<svg data-test="d"><text>x</text></svg>';
  document.body.appendChild(block);
  expect(() => enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS })).not.toThrow();
  expect((block.querySelector("pre.mmd-source code") as HTMLElement).textContent).toBe("");
});

test("detach removes the source-toggle listener too", () => {
  const block = makeBlock();
  const detach = enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
  detach();
  (block.querySelector('[aria-label="Show diagram source"]') as HTMLElement).click();
  expect(block.classList.contains("mmd-source-mode")).toBe(false); // listener gone → no toggle
});

test("labels drive the button text: a non-English catalog reaches the DOM", () => {
  const block = makeBlock();
  enhanceMermaidBlock(block, {
    onExpand: () => {},
    labels: { ...LABELS, source: "查看图表源码", download: "下载为 PNG" },
  });
  expect(block.querySelector('[aria-label="查看图表源码"]')).not.toBeNull();
  expect(block.querySelector('[aria-label="下载为 PNG"]')).not.toBeNull();
});
