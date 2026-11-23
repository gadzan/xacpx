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

test("initializes mermaid with htmlLabels:false so labels are native SVG <text> (survive sanitize)", async () => {
  let cfg: Record<string, unknown> | null = null;
  __setMermaidLoaderForTest(() =>
    Promise.resolve({
      initialize: (c: Record<string, unknown>) => { cfg = c; },
      render: async () => ({ svg: "<svg><text>x</text></svg>" }),
    }),
  );
  await hydrateMermaidBlocks(block("graph TD\n A-->B"), "dark");
  expect(cfg).not.toBeNull();
  // htmlLabels:false makes mermaid emit <text>/<tspan> instead of <div> in <foreignObject> —
  // the latter is stripped by the svg-only DOMPurify pass, leaving empty node boxes.
  const c = cfg as unknown as { htmlLabels?: unknown; flowchart?: { htmlLabels?: unknown } };
  expect(c.htmlLabels).toBe(false);
  expect(c.flowchart?.htmlLabels).toBe(false);
});

test("sanitize drops <foreignObject> HTML labels — the reason htmlLabels must be false", async () => {
  __setMermaidLoaderForTest(() =>
    Promise.resolve({
      initialize: () => {},
      // Emulate what mermaid emits WITH htmlLabels (the mode we deliberately avoid): the label text
      // lives in an HTML <div> inside <foreignObject>. Our svg-only sanitize removes foreignObject
      // outright (it's not in DOMPurify's svg allowlist), taking the label with it. This test pins
      // that hazard so nobody "simplifies" htmlLabels:false away expecting foreignObject to survive.
      render: async () => ({
        svg: '<svg><g class="node"><foreignObject><div class="label">HELLOLABEL</div></foreignObject></g></svg>',
      }),
    }),
  );
  const root = block("graph TD\n A-->B");
  await hydrateMermaidBlocks(root, "dark");
  const pre = root.querySelector("pre.mermaid-block")!;
  expect(pre.querySelector("foreignObject")).toBeNull();
  expect(pre.textContent).not.toContain("HELLOLABEL");
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

test("shouldAbort after render resolves: SVG is never committed to a torn-down DOM", async () => {
  // The component captured this root, then unmounted (or resumed streaming) while mermaid.render
  // was in flight. shouldAbort flips true once render resolves, so the block must stay on its
  // code fallback — no innerHTML rewrite, no data-mermaid-done, no mermaid-rendered class.
  let rendered = false;
  __setMermaidLoaderForTest(() =>
    Promise.resolve({
      initialize: () => {},
      render: async () => {
        rendered = true;
        return { svg: "<svg><text>x</text></svg>" };
      },
    }),
  );
  const root = block("graph TD\n A-->B");
  await hydrateMermaidBlocks(root, "dark", () => rendered); // false at loop entry, true after render
  const pre = root.querySelector("pre.mermaid-block")!;
  expect(rendered).toBe(true); // render did run — the abort is post-await, not a skip-before-start
  expect(pre.hasAttribute("data-mermaid-done")).toBe(false);
  expect(pre.querySelector("svg")).toBeNull();
  expect(pre.querySelector("code")?.textContent).toBe("graph TD\n A-->B");
});

test("shouldAbort after render REJECTS: error state is not written to a torn-down DOM", async () => {
  // The failure branch must honor the same abort contract as the success branch: if the component
  // unmounts / resumes streaming while mermaid.render is in flight and it then rejects, the stale
  // block must NOT be marked error either — it stays on its untouched code fallback.
  let rejected = false;
  __setMermaidLoaderForTest(() =>
    Promise.resolve({
      initialize: () => {},
      render: async () => {
        rejected = true;
        throw new Error("boom");
      },
    }),
  );
  const root = block("graph TD\n A-->B");
  await hydrateMermaidBlocks(root, "dark", () => rejected); // false at loop entry, true after the reject
  const pre = root.querySelector("pre.mermaid-block")!;
  expect(rejected).toBe(true); // render did run and reject — abort is post-await, not a skip-before-start
  expect(pre.hasAttribute("data-mermaid-done")).toBe(false);
  expect(pre.classList.contains("mermaid-error")).toBe(false);
  expect(pre.querySelector("code")?.textContent).toBe("graph TD\n A-->B");
});

test("shouldAbort true before the loop: no block is touched", async () => {
  const render = vi.fn(async () => ({ svg: "<svg><text>x</text></svg>" }));
  __setMermaidLoaderForTest(() => Promise.resolve({ initialize: () => {}, render }));
  const root = block("graph TD\n A-->B");
  await hydrateMermaidBlocks(root, "dark", () => true);
  expect(render).not.toHaveBeenCalled(); // aborted before starting any block
  expect(root.querySelector("pre.mermaid-block")!.hasAttribute("data-mermaid-done")).toBe(false);
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
