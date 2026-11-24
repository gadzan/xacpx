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
  test("slugs the diagram's first line", () => {
    expect(pngFileName("graph TD\n  A --> B")).toBe("diagram-graph-td.png");
    expect(pngFileName("sequenceDiagram\n  A->>B: hi")).toBe("diagram-sequencediagram.png");
  });

  test("skips leading blank lines", () => {
    expect(pngFileName("\n\n  flowchart LR\nA-->B")).toBe("diagram-flowchart-lr.png");
  });

  test("falls back to diagram.png when nothing is sluggable", () => {
    expect(pngFileName("")).toBe("diagram.png");
    expect(pngFileName("   ")).toBe("diagram.png");
    expect(pngFileName("部署流程")).toBe("diagram.png");
    expect(pngFileName("---")).toBe("diagram.png");
  });

  test("produces a safe filename: no path separators, spaces, or trailing dashes", () => {
    const name = pngFileName("graph /../../etc/passwd TD!!!");
    expect(name).not.toMatch(/[/\\\s]/);
    expect(name).toMatch(/^diagram-[a-z0-9-]*[a-z0-9]\.png$/);
  });

  test("caps the length of a rambling first line", () => {
    expect(pngFileName("a".repeat(200)).length).toBeLessThanOrEqual("diagram-".length + 40 + ".png".length);
  });
});
