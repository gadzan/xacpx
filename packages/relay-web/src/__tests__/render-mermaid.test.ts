import { afterEach, expect, test, vi } from "vitest";
import {
  hydrateMermaidBlocks,
  resetMermaidBlocks,
  __setMermaidLoaderForTest,
  type MermaidTheme,
} from "../lib/render-mermaid";
import { encodeMermaidSource } from "../lib/mermaid-source";

function block(src: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `<pre class="mermaid-block" data-mermaid="${encodeMermaidSource(src)}"><code>${src}</code></pre>`;
  return root;
}

afterEach(() => __setMermaidLoaderForTest(null));

test("hydrate replaces the placeholder with sanitized SVG and marks it done", async () => {
  __setMermaidLoaderForTest(() =>
    Promise.resolve({
      initialize: () => {},
      render: async (_id: string, text: string) => ({
        svg: `<svg data-src="${text.length}"><text>ok</text><script>alert(1)</script></svg>`,
      }),
    }),
  );
  const root = block("graph TD\n A-->B");
  await hydrateMermaidBlocks(root, "dark");
  const pre = root.querySelector("pre.mermaid-block")!;
  expect(pre.querySelector("svg")).not.toBeNull();
  expect(pre.querySelector("script")).toBeNull(); // DOMPurify svg profile strips it
  expect(pre.getAttribute("data-mermaid-done")).toBe("1");
  expect(pre.classList.contains("mermaid-rendered")).toBe(true);
});

test("hydrate caches by theme+source: identical re-hydrate does not re-invoke render", async () => {
  const render = vi.fn(async (_id: string, _text: string) => ({ svg: "<svg><text>x</text></svg>" }));
  __setMermaidLoaderForTest(() => Promise.resolve({ initialize: () => {}, render }));
  const a = block("graph TD\n A-->B");
  const b = block("graph TD\n A-->B");
  await hydrateMermaidBlocks(a, "dark");
  await hydrateMermaidBlocks(b, "dark");
  expect(render).toHaveBeenCalledTimes(1); // second block served from cache
  await hydrateMermaidBlocks(block("graph TD\n A-->B"), "light");
  expect(render).toHaveBeenCalledTimes(2); // different theme → separate render
});

test("a failing render marks the block as error and keeps the code fallback", async () => {
  __setMermaidLoaderForTest(() =>
    Promise.resolve({ initialize: () => {}, render: async () => { throw new Error("bad diagram"); } }),
  );
  const root = block("not a diagram");
  await hydrateMermaidBlocks(root, "dark"); // must not throw
  const pre = root.querySelector("pre.mermaid-block")!;
  expect(pre.getAttribute("data-mermaid-done")).toBe("error");
  expect(pre.classList.contains("mermaid-error")).toBe(true);
  expect(pre.querySelector("code")?.textContent).toBe("not a diagram");
  expect(pre.querySelector("svg")).toBeNull();
});

test("resetMermaidBlocks reverts a rendered block to its code fallback", async () => {
  __setMermaidLoaderForTest(() =>
    Promise.resolve({ initialize: () => {}, render: async () => ({ svg: "<svg><text>x</text></svg>" }) }),
  );
  const root = block("graph TD\n A-->B");
  await hydrateMermaidBlocks(root, "dark");
  resetMermaidBlocks(root);
  const pre = root.querySelector("pre.mermaid-block")!;
  expect(pre.hasAttribute("data-mermaid-done")).toBe(false);
  expect(pre.querySelector("svg")).toBeNull();
  expect(pre.querySelector("code")?.textContent).toBe("graph TD\n A-->B");
});
