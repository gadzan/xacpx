import type { LineMatch } from "./find-in-lines";

// Layer search highlights and line-scrolling onto an ALREADY-rendered (e.g. Shiki)
// container, without rebuilding its HTML — so syntax highlighting survives. Shiki emits one
// `<span class="line">` per source line; we anchor to those.

const MARK_CLASS = "search-hit";
const CURRENT_CLASS = "is-current";

/** The per-source-line elements, in order. Empty when the body is a plain `<pre>` fallback
 *  (no Shiki), in which case search/scroll-to-line degrade — callers handle that. */
export function lineElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".line"));
}

/** Remove every search mark, splicing each `<mark>`'s children back in place and merging the
 *  text nodes so the DOM returns to its pristine (pre-search) shape. */
export function clearMarks(container: HTMLElement): void {
  const marks = container.querySelectorAll<HTMLElement>(`mark.${MARK_CLASS}`);
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    (parent as Element & { normalize(): void }).normalize();
  });
}

/** Wrap [start,end) inside `root` in `<mark>`, returning the created marks left-to-right. A
 *  range spanning several text nodes (e.g. split across syntax token spans) yields one mark
 *  per covered node. Wraps covered slices last-to-first so earlier node refs/offsets stay
 *  valid as `surroundContents` splits text nodes. */
function wrapRange(root: HTMLElement, start: number, end: number): HTMLElement[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pieces: { node: Text; s: number; e: number }[] = [];
  let offset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const len = text.nodeValue?.length ?? 0;
    const nodeStart = offset;
    const nodeEnd = offset + len;
    if (nodeEnd > start && nodeStart < end) {
      pieces.push({ node: text, s: Math.max(start, nodeStart) - nodeStart, e: Math.min(end, nodeEnd) - nodeStart });
    }
    offset = nodeEnd;
    if (offset >= end) break;
  }
  const marks: HTMLElement[] = [];
  for (let i = pieces.length - 1; i >= 0; i--) {
    const { node: text, s, e } = pieces[i];
    const range = document.createRange();
    range.setStart(text, s);
    range.setEnd(text, e);
    const mark = document.createElement("mark");
    mark.className = MARK_CLASS;
    range.surroundContents(mark);
    marks.unshift(mark);
  }
  return marks;
}

/** Clear old marks, then wrap every match. Returns one anchor `<mark>` per input match (the
 *  leftmost when a match spans token spans), in the same order as `matches` — the caller
 *  indexes this for prev/next. Matches on the same line are wrapped right-to-left so wrapping
 *  one doesn't shift the offsets of earlier ones. */
export function applyMarks(container: HTMLElement, matches: LineMatch[]): HTMLElement[] {
  clearMarks(container);
  const lines = lineElements(container);
  const anchors: (HTMLElement | null)[] = new Array(matches.length).fill(null);

  // Group match indices by line, each list kept ascending by start.
  const byLine = new Map<number, number[]>();
  for (let i = 0; i < matches.length; i++) {
    const arr = byLine.get(matches[i].line);
    if (arr) arr.push(i);
    else byLine.set(matches[i].line, [i]);
  }

  for (const [line, idxs] of byLine) {
    const el = lines[line];
    if (!el) continue;
    // Wrap later (rightmost) matches first so earlier matches' offsets remain valid.
    for (let k = idxs.length - 1; k >= 0; k--) {
      const m = matches[idxs[k]];
      const marks = wrapRange(el, m.start, m.start + m.length);
      anchors[idxs[k]] = marks[0] ?? null;
    }
  }
  return anchors.filter((m): m is HTMLElement => m !== null);
}

/** Mark the i-th anchor as current (others not) and scroll its line into view. */
export function setCurrent(anchors: HTMLElement[], i: number): void {
  anchors.forEach((m, j) => m.classList.toggle(CURRENT_CLASS, j === i));
  const el = anchors[i];
  if (!el) return;
  const line = el.closest<HTMLElement>(".line") ?? el;
  line.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Scroll to source line `n` (1-based) and flash a transient highlight on it. Uses the
 *  `.line` element when present, else a line-height offset fallback for plain `<pre>`. */
export function scrollToLine(container: HTMLElement, n: number, flashMs = 1500): void {
  const lines = lineElements(container);
  const el = lines[n - 1];
  if (el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("line-flash");
    setTimeout(() => el.classList.remove("line-flash"), flashMs);
    return;
  }
  // Plain-<pre> fallback: approximate with line height.
  const pre = container.querySelector("pre") ?? container;
  const lh = parseFloat(getComputedStyle(pre).lineHeight) || 18;
  container.scrollTop = Math.max(0, (n - 1) * lh - container.clientHeight / 2);
}
