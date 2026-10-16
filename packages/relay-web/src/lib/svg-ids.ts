/** Give every `id` inside a brand SVG (gradients, clip paths) a per-instance suffix and
 *  rewrite its `url(#…)` / `href="#…"` references to match. The raw markup ships fixed
 *  ids, and the same icon mounts several times per page; ids are document-global, so
 *  every copy would resolve `url(#id)` to the first one in DOM order. When that first copy
 *  sits in a `display:none` subtree (e.g. the mobile session bar on desktop) the paint
 *  server is not rendered and every other copy of the glyph paints nothing. */
export function scopeSvgIds(svg: string | null, scope: string): string | null {
  if (!svg) return svg;
  const ids = Array.from(svg.matchAll(/\bid="([^"]+)"/g), (m) => m[1]!);
  if (ids.length === 0) return svg;
  const suffix = `-${scope.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const idSet = new Set(ids);
  return svg
    .replace(/\bid="([^"]+)"/g, (_m, id: string) => `id="${id}${suffix}"`)
    .replace(/url\(#([^)]+)\)/g, (m, id: string) => (idSet.has(id) ? `url(#${id}${suffix})` : m))
    .replace(/(href=")#([^"]+)"/g, (m, attr: string, id: string) => (idSet.has(id) ? `${attr}#${id}${suffix}"` : m));
}
