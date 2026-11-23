// Read an SVG's intrinsic pixel size for fit-to-container math. Mermaid always emits a viewBox, so
// prefer it (it's the diagram's true coordinate size, independent of any fluid `max-width` style);
// fall back to a measured bounding box. Returns null when nothing is measurable — e.g. jsdom, where
// getBoundingClientRect returns zeros — so callers can skip fitting and leave the natural render.
export function readSvgIntrinsicSize(svg: SVGSVGElement): { width: number; height: number } | null {
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { width: vb.width, height: vb.height };
  const r = svg.getBoundingClientRect?.();
  if (r && r.width > 0 && r.height > 0) return { width: r.width, height: r.height };
  return null;
}
