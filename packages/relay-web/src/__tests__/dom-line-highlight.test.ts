import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyMarks, clearMarks, setCurrent, scrollToLine, lineElements } from "../lib/dom-line-highlight";
import { findInLines } from "../lib/find-in-lines";

// jsdom doesn't implement scrollIntoView; stub it so the scroll calls are no-ops we can spy.
beforeEach(() => {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** Build a Shiki-like container: one `.line` per source line; the given token spans model
 *  syntax-highlight tokens (which may split a word across text nodes). */
function makeContainer(lines: string[][]): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML =
    '<pre class="shiki"><code>' +
    lines.map((toks) => `<span class="line">${toks.map((t) => `<span>${t}</span>`).join("")}</span>`).join("") +
    "</code></pre>";
  return el;
}

describe("dom-line-highlight", () => {
  it("wraps each match in a <mark>, one anchor per match, in order", () => {
    const container = makeContainer([["const foo = bar"], ["return foobar"]]);
    const matches = findInLines(["const foo = bar", "return foobar"], "foo");
    const anchors = applyMarks(container, matches);

    expect(anchors).toHaveLength(2);
    expect(container.querySelectorAll("mark.search-hit")).toHaveLength(2);
    anchors.forEach((m) => expect(m.textContent).toBe("foo"));
  });

  it("wraps a match that spans multiple token spans (still one anchor, ≥1 mark)", () => {
    // "foo" split as "fo" + "obar" across two token spans.
    const container = makeContainer([["fo", "obar"]]);
    const matches = findInLines(["foobar"], "foo");
    const anchors = applyMarks(container, matches);

    expect(anchors).toHaveLength(1); // one logical match
    const marks = container.querySelectorAll("mark.search-hit");
    expect(marks.length).toBe(2); // split across two nodes
    expect(Array.from(marks).map((m) => m.textContent).join("")).toBe("foo");
  });

  it("clearMarks restores the original text", () => {
    const container = makeContainer([["const foo = bar"]]);
    const before = container.textContent;
    applyMarks(container, findInLines(["const foo = bar"], "foo"));
    expect(container.querySelectorAll("mark.search-hit").length).toBeGreaterThan(0);
    clearMarks(container);
    expect(container.querySelectorAll("mark.search-hit")).toHaveLength(0);
    expect(container.textContent).toBe(before);
  });

  it("re-applying replaces the old marks rather than nesting them", () => {
    const container = makeContainer([["foo foo"]]);
    applyMarks(container, findInLines(["foo foo"], "foo"));
    const second = applyMarks(container, findInLines(["foo foo"], "foo"));
    expect(second).toHaveLength(2);
    expect(container.querySelectorAll("mark.search-hit")).toHaveLength(2);
    expect(container.querySelectorAll("mark.search-hit mark").length).toBe(0); // no nesting
  });

  it("setCurrent toggles is-current onto exactly one anchor and scrolls it", () => {
    const container = makeContainer([["foo"], ["foo"]]);
    const anchors = applyMarks(container, findInLines(["foo", "foo"], "foo"));
    setCurrent(anchors, 1);
    expect(anchors[0].classList.contains("is-current")).toBe(false);
    expect(anchors[1].classList.contains("is-current")).toBe(true);
    expect((anchors[1].closest(".line") as HTMLElement).scrollIntoView).toHaveBeenCalled();
  });

  it("scrollToLine scrolls the n-th line element and flashes it", () => {
    const container = makeContainer([["a"], ["b"], ["c"]]);
    scrollToLine(container, 2);
    const line2 = lineElements(container)[1];
    expect(line2.scrollIntoView).toHaveBeenCalled();
    expect(line2.classList.contains("line-flash")).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(line2.classList.contains("line-flash")).toBe(false);
  });
});
