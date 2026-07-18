import { afterEach, expect, test } from "vitest";
import { applyNodeLabelContrast, hydrateMermaidBlocks, __setMermaidLoaderForTest } from "../lib/render-mermaid";
import { encodeMermaidSource } from "../lib/mermaid-source";

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

function mermaidBlock(src: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `<pre class="mermaid-block" data-mermaid="${encodeMermaidSource(src)}"><code>${src}</code></pre>`;
  document.body.appendChild(root); // getComputedStyle needs it in-document
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
  __setMermaidLoaderForTest(null);
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

test("skips nodes whose label color is unresolvable (text fill:none)", () => {
  // Shape fill resolves (dark) so we reach the text-color check; the text fill
  // does not, so the pass must leave the label untouched rather than recolor it.
  const root = nodeSvg("rgb(31, 32, 32)", "none");
  applyNodeLabelContrast(root);
  expect(textFill(root)).toBe("none");
});

// Threshold boundary: white text on gray(148) ≈ 3.03 (>= 3.0) vs gray(149) ≈ 2.99
// (< 3.0). These bracket MIN_LABEL_CONTRAST and pin both its value (a raise to 4.5
// would recolor the 3.03 case) and its >= direction (equal stays untouched).
test("leaves a label just at/above the 3.0 threshold untouched (gray 148 ≈ 3.03)", () => {
  const root = nodeSvg("rgb(148, 148, 148)", "rgb(255, 255, 255)");
  applyNodeLabelContrast(root);
  expect(textFill(root)).toBe("rgb(255, 255, 255)");
});

test("recolors a label just below the 3.0 threshold (gray 149 ≈ 2.99)", () => {
  const root = nodeSvg("rgb(149, 149, 149)", "rgb(255, 255, 255)");
  applyNodeLabelContrast(root);
  expect(textFill(root)).toBe("rgb(0, 0, 0)"); // black wins against a mid-gray fill
});

test("hydrateMermaidBlocks fixes a low-contrast node label end to end", async () => {
  __setMermaidLoaderForTest(() =>
    Promise.resolve({
      initialize: () => {},
      render: async () => ({
        svg:
          `<svg><g class="node">` +
          `<rect style="fill: rgb(224, 255, 255)"></rect>` +
          `<text style="fill: rgb(204, 204, 204)">Hi</text>` +
          `</g></svg>`,
      }),
    }),
  );
  const root = mermaidBlock("graph TD\n A-->B");
  await hydrateMermaidBlocks(root, "dark");
  const text = root.querySelector("pre.mermaid-block text") as unknown as SVGElement;
  expect(text.style.fill).toBe("rgb(0, 0, 0)");
});
