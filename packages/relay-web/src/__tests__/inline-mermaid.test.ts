import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { enhanceMermaidBlock } from "../lib/inline-mermaid";
import { downloadSvgAsPng } from "../lib/mermaid-export";
import { encodeMermaidSource } from "../lib/mermaid-source";

// The rasterizer itself is canvas glue jsdom cannot run; stub it so the button's pending/failure
// behaviour (which is this module's job) is drivable. pngFileName stays real.
vi.mock("../lib/mermaid-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/mermaid-export")>()),
  downloadSvgAsPng: vi.fn(async () => true),
}));
const mockDownload = vi.mocked(downloadSvgAsPng);
beforeEach(() => {
  mockDownload.mockReset();
  mockDownload.mockResolvedValue(true);
});

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

// The reset path a theme switch takes: detach → resetMermaidBlocks (which rebuilds the block from
// its source and knows nothing about `mmd-source-mode`) → re-hydrate → re-enhance. The enhancer owns
// that class, so it must clear it — otherwise the fresh enhancement starts at showingSource=false /
// aria-pressed="false" while the CSS still hides the diagram, and the first click is a no-op.
test("re-enhancing a block left in source mode comes back showing the DIAGRAM", () => {
  const block = makeBlock();
  const detach = enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
  (block.querySelector('[aria-label="Show diagram source"]') as HTMLElement).click();
  expect(block.classList.contains("mmd-source-mode")).toBe(true);

  // Replay the reset: detach, rebuild the block's children exactly as resetMermaidBlocks does, and
  // re-enhance. The class survives all of that — it lives on the block, which is never replaced.
  detach();
  const code = document.createElement("code");
  code.textContent = SOURCE;
  block.replaceChildren(code);
  block.classList.remove("mermaid-rendered", "mermaid-error");
  expect(block.classList.contains("mmd-source-mode")).toBe(true); // reset did NOT clear it

  block.classList.add("mermaid-rendered");
  block.innerHTML = '<svg data-test="d2"><text>x</text></svg>'; // re-hydrated svg
  enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });

  expect(block.classList.contains("mmd-source-mode")).toBe(false);
  expect(
    (block.querySelector('[aria-label="Show diagram source"]') as HTMLElement).getAttribute("aria-pressed"),
  ).toBe("false");
  // And the toggle is live on the FIRST click, not the second.
  (block.querySelector('[aria-label="Show diagram source"]') as HTMLElement).click();
  expect(block.classList.contains("mmd-source-mode")).toBe(true);
});

// U+2B07 alone is Emoji_Presentation=Yes → iOS/Android/macOS paint it as a blue emoji and ignore the
// bar's colour. U+FE0E forces text presentation. Cannot be observed headlessly; pin the code points.
test("the download glyph carries the text-presentation selector (U+FE0E)", () => {
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
  const glyph = (block.querySelector('[aria-label="Download as PNG"]') as HTMLElement).textContent ?? "";
  expect([...glyph].map((c) => c.codePointAt(0))).toEqual([0x2b07, 0xfe0e]);
});

// A rasterization can fail (Image.onerror, toBlob → null). Without this the user taps and nothing
// EVER happens — no pending state, no error, and a second tap queues a second raster.
test("⬇ disables itself while exporting, so a double-tap cannot queue two rasterizations", async () => {
  let release: (v: boolean) => void = () => {};
  mockDownload.mockReturnValue(new Promise<boolean>((resolve) => { release = resolve; }));
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
  const button = block.querySelector('[aria-label="Download as PNG"]') as HTMLButtonElement;

  button.click();
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");

  button.click(); // second tap while in flight
  expect(mockDownload).toHaveBeenCalledTimes(1);

  release(true);
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(button.hasAttribute("aria-busy")).toBe(false);
});

test("a failed export reports through onExportError (and never throws)", async () => {
  mockDownload.mockResolvedValue(false);
  const errors: number[] = [];
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {}, onExportError: () => errors.push(1), labels: LABELS });
  const button = block.querySelector('[aria-label="Download as PNG"]') as HTMLButtonElement;

  button.click();
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  expect(button.disabled).toBe(false); // and the button is usable again for a retry
});

test("a SUCCESSFUL export stays silent", async () => {
  mockDownload.mockResolvedValue(true);
  const errors: number[] = [];
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {}, onExportError: () => errors.push(1), labels: LABELS });
  const button = block.querySelector('[aria-label="Download as PNG"]') as HTMLButtonElement;

  button.click();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(errors).toHaveLength(0);
});

test("a failed export with no onExportError wired is still safe", async () => {
  mockDownload.mockResolvedValue(false);
  const block = makeBlock();
  enhanceMermaidBlock(block, { onExpand: () => {}, labels: LABELS });
  const button = block.querySelector('[aria-label="Download as PNG"]') as HTMLButtonElement;
  expect(() => button.click()).not.toThrow();
  await vi.waitFor(() => expect(button.disabled).toBe(false));
});
