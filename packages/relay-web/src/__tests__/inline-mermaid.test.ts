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
