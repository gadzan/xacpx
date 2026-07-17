import { afterEach, describe, expect, test, vi } from "vitest";
import {
  contrastRatio,
  DARK_TEXT,
  fixLabelContrast,
  LIGHT_TEXT,
  MIN_LABEL_CONTRAST,
  parseCssColor,
  pickReadableTextColor,
  relativeLuminance,
} from "../lib/mermaid-contrast";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
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

  // Hardcoded rather than re-deriving the pick from the same helpers the implementation uses (that
  // shape of assertion restates the code and cannot fail). Mid-grey is the interesting case: it is
  // where the two-colour palette is weakest, which is the reason MIN_LABEL_CONTRAST is 3.0 and not
  // AA's 4.5 — #767676 is the worst background there is, and even the winning pick only reaches 4.17.
  test("the pick flips by luminance, well below the numeric mid-grey", () => {
    // The flip sits at grey 119 — a saturated blue that is numerically mid-bright is still dark
    // enough to need light text, which is the whole point of going through relative luminance.
    expect(pickReadableTextColor({ r: 118, g: 118, b: 118 })).toBe("#f5f5f5"); // #767676
    expect(pickReadableTextColor({ r: 119, g: 119, b: 119 })).toBe("#111111");
    expect(pickReadableTextColor({ r: 128, g: 128, b: 128 })).toBe("#111111");
    expect(pickReadableTextColor({ r: 100, g: 180, b: 20 })).toBe("#111111");
    expect(pickReadableTextColor({ r: 20, g: 40, b: 160 })).toBe("#f5f5f5");
  });

  // MIN_LABEL_CONTRAST must stay at or below what the two-colour palette can actually deliver:
  // above that floor, the pass would repaint labels that are already better than the repair.
  // Reads the real constants, so widening the palette or raising the threshold reddens this.
  test("MIN_LABEL_CONTRAST sits at or below the palette's worst-case ceiling", () => {
    let floor = Infinity;
    let floorAt = -1;
    for (let grey = 0; grey <= 255; grey += 1) {
      const bg = { r: grey, g: grey, b: grey };
      const best = Math.max(
        contrastRatio(parseCssColor(DARK_TEXT)!, bg),
        contrastRatio(parseCssColor(LIGHT_TEXT)!, bg),
      );
      if (best < floor) {
        floor = best;
        floorAt = grey;
      }
    }
    expect(floorAt).toBe(118); // ~#767676
    expect(floor).toBeCloseTo(4.166, 2);
    expect(MIN_LABEL_CONTRAST).toBeLessThanOrEqual(floor);
  });
});

// jsdom cannot run real mermaid (getBBox is unimplemented), so these are hand-built fixtures.
//
// More importantly: in production this pass ALWAYS reads colours out of getComputedStyle (it runs on
// an attached svg, and mermaid's colours arrive through the <style> block it injects — the `fill`
// attribute alone is not even enough). jsdom does not resolve SVG presentation properties and
// returns "" for `fill`, which would silently route every test down the attribute FALLBACK and prove
// the no-op guarantees about a path the browser never takes. So the fixtures carry their colour in
// `data-cfill` only, and `stubComputedFill` resolves it the way Chromium would — the attribute
// fallback then has nothing to find, which is what makes "we drove the computed branch" checkable.
function makeSvg(nodes: string): SVGElement {
  const host = document.createElement("div");
  host.innerHTML = `<svg>${nodes}</svg>`;
  document.body.appendChild(host);
  return host.querySelector("svg") as unknown as SVGElement;
}

function stubComputedFill(): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(((el: Element, pseudo?: string | null) => {
    const cfill = el?.getAttribute?.("data-cfill");
    const fillOpacity = el?.getAttribute?.("data-cfill-opacity");
    const opacity = el?.getAttribute?.("data-copacity");
    if (cfill === null && fillOpacity === null && opacity === null) return real(el as Element, pseudo);
    return {
      getPropertyValue: (prop: string) => {
        if (prop === "fill") return cfill ?? "";
        if (prop === "fill-opacity") return fillOpacity ?? "1";
        if (prop === "opacity") return opacity ?? "1";
        return "";
      },
    } as unknown as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle);
}

function node(shapeFill: string, textFill: string, opts?: { tspan?: boolean; cls?: string }): string {
  const label = opts?.tspan
    ? `<text data-cfill="${textFill}"><tspan data-cfill="${textFill}">hi</tspan></text>`
    : `<text data-cfill="${textFill}">hi</text>`;
  return `<g class="${opts?.cls ?? "node"}"><rect data-cfill="${shapeFill}"></rect>${label}</g>`;
}

describe("fixLabelContrast (computed-style path — what a browser actually takes)", () => {
  test("recolors a failing label: theme #ccc text on an author-pinned light fill", () => {
    stubComputedFill();
    const svg = makeSvg(node("#e0ffff", "#cccccc"));
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });

  test("recolors toward light text when the author pins a DARK fill", () => {
    stubComputedFill();
    const svg = makeSvg(node("#101010", "#333333"));
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#f5f5f5");
  });

  // The whole point of the >= 3.0 early-out: mermaid's designed palettes must come out byte-identical.
  test("NO-OP for mermaid's own default-theme pairing (#333 on #ECECFF)", () => {
    stubComputedFill();
    const svg = makeSvg(node("#ECECFF", "#333333"));
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
    expect(svg.querySelector("text")!.hasAttribute("fill")).toBe(false);
  });

  test("NO-OP for mermaid's own dark-theme pairing (#ccc on #1f2020)", () => {
    stubComputedFill();
    const svg = makeSvg(node("#1f2020", "#cccccc"));
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
    expect(svg.querySelector("text")!.hasAttribute("fill")).toBe(false);
  });

  test("NO-OP for mermaid's tightest designed pairing: dark cluster #ccc on #3f3f3f (6.56)", () => {
    stubComputedFill();
    const svg = makeSvg(node("#3f3f3f", "#cccccc", { cls: "cluster" }));
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
  });

  test("is idempotent: a second pass leaves the repaired label byte-identical", () => {
    stubComputedFill();
    const svg = makeSvg(node("#e0ffff", "#cccccc"));
    fixLabelContrast(svg);
    // The repair writes a real `fill`/`style`, so the second pass reads #111111 back through the
    // computed stub only if we mirror it into data-cfill — which is exactly what a browser would do.
    const text = svg.querySelector("text")!;
    text.setAttribute("data-cfill", text.getAttribute("fill")!);
    const after = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(after); // >= 3.0 early-out, no marker attribute needed
  });

  test("also repaints tspans, which would otherwise win over the parent text", () => {
    stubComputedFill();
    const svg = makeSvg(node("#e0ffff", "#cccccc", { tspan: true }));
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
    expect(svg.querySelector("tspan")!.getAttribute("fill")).toBe("#111111");
  });

  test("covers clusters, not just nodes", () => {
    stubComputedFill();
    const svg = makeSvg(node("#e0ffff", "#cccccc", { cls: "cluster" }));
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });

  test("skips a node whose shape has no paintable fill", () => {
    for (const fill of ["none", "rgba(0, 0, 0, 0)", "url(#grad)"]) {
      stubComputedFill();
      const svg = makeSvg(node(fill, "#cccccc"));
      fixLabelContrast(svg);
      expect(svg.querySelector("text")!.hasAttribute("fill")).toBe(false);
      document.body.innerHTML = "";
      vi.restoreAllMocks();
    }
  });

  test("uses the first paintable shape and ignores a leading fill:none outline", () => {
    stubComputedFill();
    const svg = makeSvg(
      '<g class="node"><path data-cfill="none"></path><rect data-cfill="#e0ffff"></rect>' +
        '<text data-cfill="#cccccc">hi</text></g>',
    );
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });

  test("leaves everything outside g.node / g.cluster alone (edge labels, standalone text)", () => {
    stubComputedFill();
    const svg = makeSvg('<g class="edgeLabel"><rect data-cfill="#e0ffff"></rect><text data-cfill="#cccccc">e</text></g>');
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.hasAttribute("fill")).toBe(false);
  });

  test("one malformed node cannot abort the pass", () => {
    stubComputedFill();
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
    stubComputedFill();
    const svg = makeSvg("<text>bare</text>");
    expect(() => fixLabelContrast(svg)).not.toThrow();
    expect(svg.querySelector("text")!.hasAttribute("fill")).toBe(false);
  });
});

// `style A fill:#f0f0f0,color:#c0c0c0` — a deliberately greyed-out "not built yet" node — is a
// normal idiom, and mermaid honours the author's `color:` on the native <text>. Repainting it to
// #111 at 16.6:1 would turn the most-muted node into the loudest one on the chart. Mermaid delivers
// an author colour as an inline `style="color: … !important"` on an ANCESTOR <g>; a theme default
// arrives only through the injected <style>, where no ancestor carries an inline colour.
describe("fixLabelContrast: an author-specified label colour is never touched", () => {
  test("fill-only (no author colour) → repaired", () => {
    stubComputedFill();
    const svg = makeSvg('<g class="node"><rect data-cfill="#f0f0f0"></rect><text data-cfill="#cccccc">hi</text></g>');
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });

  test("fill + author color → left exactly alone, however bad the contrast", () => {
    stubComputedFill();
    const svg = makeSvg(
      '<g class="node" style="color: #c0c0c0 !important">' +
        '<rect data-cfill="#f0f0f0"></rect><text data-cfill="#c0c0c0">hi</text></g>',
    );
    const before = svg.innerHTML;
    // The pairing really is failing — this is a skip, not a pass on contrast.
    expect(contrastRatio(parseCssColor("#c0c0c0")!, parseCssColor("#f0f0f0")!)).toBeLessThan(3);
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
  });

  test("the author colour is honoured from any ancestor, not just the immediate parent", () => {
    stubComputedFill();
    const svg = makeSvg(
      '<g class="node" style="color: #c0c0c0 !important"><g class="label"><g>' +
        '<rect data-cfill="#f0f0f0"></rect><text data-cfill="#c0c0c0">hi</text></g></g></g>',
    );
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
  });

  test("the <text>'s OWN inline colour does not count — otherwise the pass eats its own repair", () => {
    stubComputedFill();
    // recolor() writes style.color onto the text; a second pass must still see this as ours to fix.
    const svg = makeSvg('<g class="node"><rect data-cfill="#f0f0f0"></rect>' +
      '<text style="color: #cccccc" data-cfill="#cccccc">hi</text></g>');
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });
});

// A translucent fill composites with a backdrop we do not know. Measuring it as if opaque is worse
// than doing nothing: `fill:#ffffff1a` over mermaid-dark really lands near rgb(54,54,54), where the
// #ccc label sits at ~7.5 and is perfectly readable — but read as pure white it scores 1.6 and the
// "repair" would drop #111 on it at a real ~1.6, breaking a diagram that was fine.
describe("fixLabelContrast: a translucent fill is not measurable", () => {
  test("does not repaint when Mermaid emits alpha as a separate fill-opacity property", () => {
    stubComputedFill();
    const svg = makeSvg(
      '<g class="node"><rect data-cfill="#ffffff" data-cfill-opacity="0.1"></rect>' +
        '<text data-cfill="#cccccc">hi</text></g>',
    );
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
  });

  test("does not repaint when the shape element has independent opacity", () => {
    stubComputedFill();
    const svg = makeSvg(
      '<g class="node"><rect data-cfill="#ffffff" data-copacity="0.1"></rect>' +
        '<text data-cfill="#cccccc">hi</text></g>',
    );
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
  });

  test("does not repaint through a translucent ancestor group", () => {
    stubComputedFill();
    const svg = makeSvg(
      '<g class="node" data-copacity="0.1"><rect data-cfill="#ffffff"></rect>' +
        '<text data-cfill="#cccccc">hi</text></g>',
    );
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
  });

  test("does not repaint over a nearly-transparent author fill", () => {
    stubComputedFill();
    const svg = makeSvg(node("rgba(255, 255, 255, 0.1)", "#cccccc"));
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
  });

  test("hex-alpha too (`fill:#ffffff1a`, the form a diagram source actually writes)", () => {
    stubComputedFill();
    const svg = makeSvg(node("#ffffff1a", "#cccccc"));
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
  });

  test("falls through a translucent shape to the next OPAQUE one rather than giving up", () => {
    stubComputedFill();
    const svg = makeSvg(
      '<g class="node"><rect data-cfill="rgba(255, 255, 255, 0.1)"></rect>' +
        '<rect data-cfill="#e0ffff"></rect><text data-cfill="#cccccc">hi</text></g>',
    );
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });

  test("effectively-opaque still counts (a >= 0.9): antialiasing-grade alpha is not a real backdrop", () => {
    stubComputedFill();
    const svg = makeSvg(node("rgba(224, 255, 255, 0.95)", "#cccccc"));
    fixLabelContrast(svg);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  });

  // The same bar applies to the LABEL, not just the shape: a translucent label composites against
  // the fill it sits on, so scoring it as opaque measures a colour that is not on screen — and an
  // invisible label would get "repaired" into a visible one.
  test("does not repaint a translucent label either", () => {
    stubComputedFill();
    const svg = makeSvg(node("#101010", "rgba(0, 0, 0, 0)"));
    const before = svg.innerHTML;
    fixLabelContrast(svg);
    expect(svg.innerHTML).toBe(before);
  });

  test("does not repaint a label with separate fill-opacity or ancestor opacity", () => {
    for (const label of [
      '<text data-cfill="#cccccc" data-cfill-opacity="0.1">hi</text>',
      '<g data-copacity="0.1"><text data-cfill="#cccccc">hi</text></g>',
    ]) {
      stubComputedFill();
      const svg = makeSvg(`<g class="node"><rect data-cfill="#ffffff"></rect>${label}</g>`);
      const before = svg.innerHTML;
      fixLabelContrast(svg);
      expect(svg.innerHTML).toBe(before);
      document.body.innerHTML = "";
      vi.restoreAllMocks();
    }
  });
});

// The attribute fallback exists for engines that do not resolve SVG presentation properties through
// getComputedStyle. Production never lands here (see above), but it is what makes the function
// drivable at all, so keep one test honest about which branch it is.
test("attribute fallback: colours read straight off `fill` when computed style yields nothing", () => {
  const svg = makeSvg('<g class="node"><rect fill="#e0ffff"></rect><text fill="#cccccc">hi</text></g>');
  expect(getComputedStyle(svg.querySelector("rect")!).getPropertyValue("fill")).toBe(""); // jsdom, unstubbed
  fixLabelContrast(svg);
  expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#111111");
});

// MermaidViewer renders `svg.outerHTML` copied from this same (already-fixed) inline DOM, so the
// fullscreen view inherits the contrast fix with no code of its own. That only holds if the fix is
// written as serializable inline paint rather than, say, a JS-side style object — pin it here by
// re-parsing the way the viewer does. (Asserting the string merely LACKS "#cccccc" would pin the
// fixture, not the invariant: real mermaid output keeps its theme colours in the injected <style>
// regardless of what we painted.)
test("the fix survives outerHTML serialization (this is what MermaidViewer clones)", () => {
  stubComputedFill();
  const svg = makeSvg(node("#e0ffff", "#cccccc", { tspan: true }));
  fixLabelContrast(svg);
  const serialized = (svg as unknown as SVGSVGElement).outerHTML;

  const host = document.createElement("div");
  host.innerHTML = serialized;
  expect(host.querySelector("text")!.getAttribute("fill")).toBe("#111111");
  expect(host.querySelector("tspan")!.getAttribute("fill")).toBe("#111111");
  expect(host.querySelector("text")!.getAttribute("style") ?? "").toContain("fill");
});
