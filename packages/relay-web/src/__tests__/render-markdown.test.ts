import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../lib/render-markdown";
import { encodeMermaidSource, decodeMermaidSource } from "../lib/mermaid-source";

describe("renderMarkdown", () => {
  it("renders basic markdown structure", () => {
    const html = renderMarkdown("# Title\n\nsome **bold** and `code`");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders fenced code blocks", () => {
    const html = renderMarkdown("```\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("const x = 1;");
  });

  it("escapes raw HTML in the source (html:false)", () => {
    const html = renderMarkdown("hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not emit live event-handler attributes", () => {
    // Raw HTML is escaped to text (html:false); DOMPurify is the second guard.
    // The property that matters: no real element carries an onerror handler.
    const html = renderMarkdown("![x](x)\n\n<img src=x onerror=alert(1)>");
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain("&lt;img"); // the raw tag survives only as escaped text
  });

  it("neutralizes javascript: links (no anchor element produced)", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toMatch(/<a[^>]*href="javascript:/i);
    expect(html).not.toContain("<a "); // markdown-it refuses to linkify the unsafe scheme
  });

  it("opens surviving links in a new tab safely", () => {
    const html = renderMarkdown("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("heals unterminated bold when streaming", () => {
    const html = renderMarkdown("answer is **important", { streaming: true });
    expect(html).toContain("<strong>important</strong>");
  });

  it("heals an open code fence when streaming", () => {
    const html = renderMarkdown("```js\nconst x = 1;", { streaming: true });
    expect(html).toContain("<pre>");
    expect(html).toContain("const x = 1;");
  });

  it("leaves partial markup literal when not streaming", () => {
    const html = renderMarkdown("answer is **important");
    expect(html).not.toContain("<strong>");
    expect(html).toContain("**important");
  });

  it("wraps tables in a horizontal-scroll container (columns kept, no viewport overflow)", () => {
    const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    // The wrapper provides the scroll; the <table> keeps normal table layout.
    expect(html).toContain('<div class="md-table-wrap"><table>');
    expect(html).toContain("</table></div>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("recovers a table that the agent wrote without a blank line before it", () => {
    const html = renderMarkdown("打开它：\n| # | 功能 |\n| --- | --- |\n| 1 | 跳 |");
    expect(html).toContain('<div class="md-table-wrap"><table>');
    expect(html).toContain("<th>功能</th>");
    expect(html).toContain("<td>跳</td>");
    // the lead-in text is still its own paragraph
    expect(html).toContain("打开它：");
  });

  it("recovers a table missing its delimiter row", () => {
    const html = renderMarkdown("| a | b |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("mermaid source base64 round-trips including non-ASCII and special chars", () => {
    const src = "graph TD\n  A[开始] --> B{判断?}\n  B -->|是/yes| C[\"</code> & <script>\"]";
    const encoded = encodeMermaidSource(src);
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/); // base64 alphabet only — safe in an attribute
    expect(decodeMermaidSource(encoded)).toBe(src);
  });

  it("preserves a leading BOM through the round-trip (ignoreBOM decoder)", () => {
    const src = "﻿graph TD\n  A --> B";
    expect(decodeMermaidSource(encodeMermaidSource(src))).toBe(src);
  });

  it("a mermaid fence becomes a placeholder carrying the base64 source", () => {
    const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");
    expect(html).toContain('class="mermaid-block"');
    const match = html.match(/data-mermaid="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(decodeMermaidSource(match![1]!)).toBe("graph TD\n  A --> B\n");
    // The visible fallback keeps the (escaped) source, never blank.
    expect(html).toContain("graph TD");
  });

  it("a mermaid fence source cannot inject markup", () => {
    const html = renderMarkdown("```mermaid\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>alert(1)</script>"); // escaped in fallback, raw source only in base64
  });

  it("encodeMermaidSource is total on a lone surrogate (byte-safe, does not throw)", () => {
    // `unescape(encodeURIComponent(...))` throws URIError on an unpaired surrogate; TextEncoder
    // substitutes U+FFFD instead. This must never throw — it runs with no error isolation.
    expect(() => encodeMermaidSource("\uD800")).not.toThrow();
    expect(decodeMermaidSource(encodeMermaidSource("\uD800"))).toBe("�");
  });

  it("a mermaid fence containing a lone surrogate does not crash the whole render", () => {
    const src = "graph TD\n  A[stray \uD800 unit] --> B";
    // Old encoding threw here, taking down the entire message render, not just the diagram.
    expect(() => renderMarkdown("```mermaid\n" + src + "\n```")).not.toThrow();
    const html = renderMarkdown("```mermaid\n" + src + "\n```");
    expect(html).toContain('class="mermaid-block"');
    const match = html.match(/data-mermaid="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(decodeMermaidSource(match![1]!)).toBe("graph TD\n  A[stray � unit] --> B\n");
  });

  it("a non-mermaid fence is rendered unchanged (no mermaid-block class)", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(html).not.toContain("mermaid-block");
    expect(html).toContain("<pre"); // ordinary code block
    expect(html).toContain("const a = 1;");
  });
});
