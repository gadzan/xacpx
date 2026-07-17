import { afterEach, describe, expect, test } from "vitest";
import {
  contrastRatio,
  fixLabelContrast,
  parseCssColor,
  pickReadableTextColor,
  relativeLuminance,
} from "../lib/mermaid-contrast";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("parseCssColor", () => {
  test("parses what getComputedStyle emits in Chromium", () => {
    expect(parseCssColor("rgb(204, 204, 204)")).toEqual({ r: 204, g: 204, b: 204, a: 1 });
    expect(parseCssColor("rgba(224, 255, 255, 0.5)")).toEqual({ r: 224, g: 255, b: 255, a: 0.5 });
  });

  test("parses hex, short hex, and hex with alpha", () => {
    expect(parseCssColor("#f9f")).toEqual({ r: 255, g: 153, b: 255, a: 1 });
    expect(parseCssColor("#e0ffff")).toEqual({ r: 224, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#333")).toEqual({ r: 51, g: 51, b: 51, a: 1 });
    expect(parseCssColor("#FF0000")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseCssColor("#ff000080")?.a).toBeCloseTo(0.502, 2);
  });

  test("parses the modern slash-alpha form", () => {
    expect(parseCssColor("rgb(1 2 3 / 0.25)")).toEqual({ r: 1, g: 2, b: 3, a: 0.25 });
    expect(parseCssColor("rgb(1 2 3 / 50%)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });

  test("fully transparent parses as alpha 0 (not null) so callers can tell it apart", () => {
    expect(parseCssColor("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  test("unpaintable / unparseable inputs are null", () => {
    for (const input of ["none", "transparent", "", "   ", "url(#grad)", "#12", "rgb(1, 2)", "chartreuse"]) {
      expect(parseCssColor(input)).toBeNull();
    }
  });
});

describe("relativeLuminance / contrastRatio", () => {
  test("matches the WCAG reference values at the extremes", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    // Black-on-white is the canonical 21:1.
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 2);
  });

  test("is symmetric and never below 1", () => {
    const a = { r: 12, g: 200, b: 90 };
    const b = { r: 240, g: 30, b: 70 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
    expect(contrastRatio(a, a)).toBeCloseTo(1, 10);
  });

  test("reproduces the measured dark-mode failure: #ccc on an author-pinned light fill", () => {
    const themeText = { r: 204, g: 204, b: 204 };
    expect(contrastRatio(themeText, { r: 224, g: 255, b: 255 })).toBeLessThan(3);
    expect(contrastRatio(themeText, { r: 255, g: 153, b: 255 })).toBeLessThan(3);
  });
});

describe("pickReadableTextColor", () => {
  test("dark text on light fills, light text on dark fills", () => {
    expect(pickReadableTextColor({ r: 224, g: 255, b: 255 })).toBe("#111111");
    expect(pickReadableTextColor({ r: 255, g: 153, b: 255 })).toBe("#111111");
    expect(pickReadableTextColor({ r: 255, g: 255, b: 255 })).toBe("#111111");
    expect(pickReadableTextColor({ r: 31, g: 32, b: 32 })).toBe("#f5f5f5");
    expect(pickReadableTextColor({ r: 0, g: 0, b: 0 })).toBe("#f5f5f5");
  });

  test("whatever it picks actually beats the alternative", () => {
    for (const bg of [{ r: 128, g: 128, b: 128 }, { r: 100, g: 180, b: 20 }, { r: 20, g: 40, b: 160 }]) {
      const picked = parseCssColor(pickReadableTextColor(bg))!;
      const other = parseCssColor(pickReadableTextColor(bg) === "#111111" ? "#f5f5f5" : "#111111")!;
      expect(contrastRatio(picked, bg)).toBeGreaterThanOrEqual(contrastRatio(other, bg));
    }
  });
});

// jsdom cannot run real mermaid (getBBox is unimplemented) and will not resolve mermaid's
// id-scoped <style> rules the way Chromium does, so these fixtures set `fill` attributes directly —
// which is exactly the fallback path readFill() takes when computed style yields nothing.
function makeSvg(nodes: string): SVGElement {
  const host = document.createElement("div");
  host.innerHTML = `<svg>${nodes}</svg>`;
  document.body.appendChild(host);
  return host.querySelector("svg") as unknown as SVGElement;
}
function node(shapeFill: string, textFill: string, opts?: { tspan?: boolean; cls?: string }): string {
  const label = opts?.tspan
    ? `<text fill="${textFill}"><tspan fill="${textFill}">hi</tspan></text>`
    : `<text fill="${textFill}">hi</text>`;
  return `<g class="${opts?.cls ?? "node"}"><rect fill="${shapeFill}"></rect>${label}</g>`;
}

describe("fixLabelContrast", () => {
  test("recolors a failing label: theme #ccc text on an author-pinned light fill", () => {
    const svg = makeSvg(node("#e0ffff", "#cccccc"));
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });

  test("recolors toward light text when the author pins a DARK fill", () => {
    const svg = makeSvg(node("#101010", "#333333"));
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#f5f5f5");
  });

  // The whole point of the >= 3.0 early-out: mermaid's designed palettes must come out byte-identical.
  test("NO-OP for mermaid's own default-theme pairing (#333 on #ECECFF)", () => {
    const svg = makeSvg(node("#ECECFF", "#333333"));
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#333333");
    expect(svg.innerHTML).toBe(before);
  });

  test("NO-OP for mermaid's own dark-theme pairing (#ccc on #1f2020)", () => {
    const svg = makeSvg(node("#1f2020", "#cccccc"));
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#cccccc");
    expect(svg.innerHTML).toBe(before);
  });

  test("also repaints tspans, which would otherwise win over the parent text", () => {
    const svg = makeSvg(node("#e0ffff", "#cccccc", { tspan: true }));
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
    expect(svg.querySelector("tspan")!.getAttribute("fill")).toBe("#111111");
  });

  test("covers clusters, not just nodes", () => {
    const svg = makeSvg(node("#e0ffff", "#cccccc", { cls: "cluster" }));
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });

  test("skips a node whose shape has no paintable fill", () => {
    for (const fill of ["none", "rgba(0, 0, 0, 0)", "url(#grad)"]) {
      const svg = makeSvg(node(fill, "#cccccc"));
      fixLabelContrast(svg);
      expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#cccccc");
      document.body.innerHTML = "";
    }
  });

  test("uses the first paintable shape and ignores a leading fill:none outline", () => {
    const svg = makeSvg(
      '<g class="node"><path fill="none"></path><rect fill="#e0ffff"></rect><text fill="#cccccc">hi</text></g>',
    );
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });

  test("leaves everything outside g.node / g.cluster alone (edge labels, standalone text)", () => {
    const svg = makeSvg('<g class="edgeLabel"><rect fill="#e0ffff"></rect><text fill="#cccccc">e</text></g>');
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#cccccc");
  });

  test("one malformed node cannot abort the pass", () => {
    const svg = makeSvg(`${node("#e0ffff", "#cccccc")}${node("#e0ffff", "#cccccc")}`);
    const bad = svg.querySelectorAll("g.node")[0];
    // Make the first node throw the moment fixNode touches it.
    Object.defineProperty(bad, "querySelectorAll", {
      value: () => {
        throw new Error("boom");
      },
    });
    expect(() => fixLabelContrast(svg)).not.toThrow();
    // The second, healthy node was still fixed.
    expect(svg.querySelectorAll("g.node")[1].querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });

  test("an svg with no nodes is a silent no-op", () => {
    const svg = makeSvg("<text>bare</text>");
    expect(() => fixLabelContrast(svg)).not.toThrow();
    expect(svg.querySelector("text")!.hasAttribute("fill")).toBe(false);
  });
});

// MermaidViewer renders `svg.outerHTML` copied from this same (already-fixed) inline DOM, so the
// fullscreen view inherits the contrast fix with no code of its own. That only holds if the fix is
// written as serializable inline paint rather than, say, a JS-side style object — pin it here.
test("the fix survives outerHTML serialization (this is what MermaidViewer clones)", () => {
  const svg = makeSvg(node("#e0ffff", "#cccccc", { tspan: true }));
  fixLabelContrast(svg);
  const serialized = (svg as unknown as SVGSVGElement).outerHTML;
  expect(serialized).toContain("#111111");
  expect(serialized).not.toContain("#cccccc");
});
