import { describe, expect, test } from "vitest";
import { buildSvgDataUrl, pngFileName } from "../lib/mermaid-export";

// Only the pure helpers are covered: jsdom has no canvas, so downloadSvgAsPng's glue is left
// untested rather than faked behind a canvas polyfill dependency.

function decodeDataUrl(url: string): string {
  const b64 = url.replace(/^data:image\/svg\+xml;base64,/, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

describe("buildSvgDataUrl", () => {
  test("emits a base64 svg data URL", () => {
    expect(buildSvgDataUrl("<svg><text>a</text></svg>")).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/);
  });

  test("injects xmlns when missing (an Image refuses markup without it)", () => {
    const out = decodeDataUrl(buildSvgDataUrl('<svg width="10"><text>a</text></svg>'));
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toContain('width="10"');
    expect(out).toContain("<text>a</text>");
  });

  test("does not double-inject an xmlns that is already there", () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg"><text>a</text></svg>';
    const out = decodeDataUrl(buildSvgDataUrl(markup));
    expect(out.match(/xmlns=/g)).toHaveLength(1);
    expect(out).toBe(markup);
  });

  // The reason this does not use bare btoa: it throws on any non-Latin-1 code point, and CJK
  // diagram labels are routine here.
  test("survives non-Latin-1 labels (CJK) and round-trips them exactly", () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg"><text>部署流程 · 图表</text></svg>';
    expect(() => buildSvgDataUrl(markup)).not.toThrow();
    expect(decodeDataUrl(buildSvgDataUrl(markup))).toBe(markup);
  });

  test("survives emoji (surrogate pairs)", () => {
    const markup = "<svg><text>ship 🚀</text></svg>";
    expect(decodeDataUrl(buildSvgDataUrl(markup))).toContain("ship 🚀");
  });
});

describe("pngFileName", () => {
  test("always the same shape: diagram-<8 hex>.png", () => {
    expect(pngFileName("graph TD\n  A --> B")).toMatch(/^diagram-[0-9a-f]{8}\.png$/);
    expect(pngFileName("")).toMatch(/^diagram-[0-9a-f]{8}\.png$/);
    expect(pngFileName("部署流程\n  A --> B")).toMatch(/^diagram-[0-9a-f]{8}\.png$/);
  });

  // The point of hashing the FULL source: seeding from the first line would give every flowchart in
  // a conversation the same `diagram-flowchart-td.png`, and the browser would pile up (1), (2).
  test("diagrams that differ only below the first line still get different names", () => {
    const a = pngFileName("flowchart TD\n  A --> B");
    const b = pngFileName("flowchart TD\n  C --> D");
    expect(a).not.toBe(b);
  });

  test("re-exporting the SAME diagram is stable (a re-download overwrites, not (1), (2))", () => {
    const src = "graph TD\n  A --> B";
    expect(pngFileName(src)).toBe(pngFileName(src));
  });

  // A CJK-only source has nothing ASCII-sluggable in it; it must still get a distinguishing name.
  test("CJK sources are named and distinguished like any other", () => {
    expect(pngFileName("部署流程")).not.toBe(pngFileName("测试流程"));
  });

  test("produces a safe filename: no path separators or spaces, whatever the source holds", () => {
    const name = pngFileName("graph /../../etc/passwd TD!!!\n<script>  \n");
    expect(name).not.toMatch(/[/\\\s]/);
    expect(name).toMatch(/^diagram-[0-9a-f]{8}\.png$/);
  });

  test("a rambling source does not lengthen the name", () => {
    expect(pngFileName("a".repeat(20000))).toMatch(/^diagram-[0-9a-f]{8}\.png$/);
  });
});
