import { afterEach, expect, test } from "vitest";
import { applyNodeLabelContrast } from "../lib/render-mermaid";

// Build a mermaid-like g.node. jsdom's getComputedStyle resolves only INLINE
// style (not <style> classes / presentation attrs), so we feed fills via inline
// style.fill — enough to exercise the decision + mutation logic. The real
// class/attribute path is covered by the Chromium probe (see spec). The node
// must be in-document for getComputedStyle to resolve.
function nodeSvg(shapeFill: string, textFill: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML =
    `<svg><g class="node">` +
    `<rect style="fill: ${shapeFill}"></rect>` +
    `<text style="fill: ${textFill}">Label</text>` +
    `</g></svg>`;
  document.body.appendChild(root);
  return root;
}
function textFill(root: HTMLElement): string {
  return (root.querySelector("text") as unknown as SVGElement).style.fill;
}
afterEach(() => {
  document.body.innerHTML = "";
});

test("overrides the label color on a light fill (contrast 1.52 < 3.0)", () => {
  const root = nodeSvg("rgb(224, 255, 255)", "rgb(204, 204, 204)");
  applyNodeLabelContrast(root);
  expect(textFill(root)).toBe("rgb(0, 0, 0)");
});

test("leaves a readable label untouched (dark fill control, contrast 10.17)", () => {
  const root = nodeSvg("rgb(31, 32, 32)", "rgb(204, 204, 204)");
  applyNodeLabelContrast(root);
  expect(textFill(root)).toBe("rgb(204, 204, 204)");
});

test("skips nodes whose shape has no resolvable fill (fill:none)", () => {
  const root = nodeSvg("none", "rgb(204, 204, 204)");
  applyNodeLabelContrast(root);
  expect(textFill(root)).toBe("rgb(204, 204, 204)");
});
