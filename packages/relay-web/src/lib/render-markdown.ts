import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import remend from "remend";
import { normalizeMarkdownTables } from "./normalize-markdown";
import { encodeMermaidSource } from "./mermaid-source";

// Single shared parser. html:false escapes any raw HTML in the markdown source,
// so agent output cannot inject markup; DOMPurify is a second, defense-in-depth pass
// over the rendered HTML.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

// Wrap tables in a horizontally scrollable container so a wide table scrolls within the
// message instead of overflowing the viewport — without display:block on the <table>,
// which would collapse its column layout into a stacked single column.
md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>';
md.renderer.rules.table_close = () => "</table></div>";

// Intercept ```mermaid fences: emit a placeholder carrying the diagram source as
// attribute-safe base64. render-mermaid hydrates it into SVG after the HTML is mounted.
// The escaped <code> is the fallback shown before hydration, while streaming, and on
// render error. All other fences fall through to markdown-it's default renderer.
const defaultFence =
  md.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const info = token.info.trim().split(/\s+/g)[0]?.toLowerCase() ?? "";
  if (info !== "mermaid") {
    return defaultFence(tokens, idx, options, env, self);
  }
  const encoded = encodeMermaidSource(token.content);
  const fallback = md.utils.escapeHtml(token.content);
  return `<pre class="mermaid-block" data-mermaid="${encoded}"><code>${fallback}</code></pre>`;
};

// Force every surviving link to open safely in a new tab. Registered once at module
// load; DOMPurify is a singleton and this app only sanitizes through this module.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

export interface RenderMarkdownOptions {
  /**
   * When true the source is run through `remend` first, which auto-closes
   * unterminated markdown (a half-typed `**bold`, an open code fence, a partial
   * link) so mid-stream frames render cleanly instead of swallowing the rest of
   * the message. Use for live streaming buffers; leave false for finalized text.
   */
  streaming?: boolean;
}

/**
 * Return source offsets where a top-level Markdown block can safely hand over to
 * non-Markdown turn activity. Gaps between blocks stay attached to the preceding
 * block, so an activity observed after "\n\n" lands before the next block. Parsing
 * the raw source is intentionally conservative: normalization may recognize more
 * constructs, but it must never create an unsafe split inside the original source.
 */
export function markdownBlockBoundaries(text: string): number[] {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }

  const ranges = md
    .parse(text, {})
    .filter((token) => token.level === 0 && token.map !== null)
    .map((token) => token.map!)
    .filter((range, index, all) =>
      index === 0 || range[0] !== all[index - 1]![0] || range[1] !== all[index - 1]![1],
    );

  if (ranges.length === 0) return [text.length];
  return ranges.map((_, index) => {
    const nextStartLine = ranges[index + 1]?.[0];
    return nextStartLine === undefined
      ? text.length
      : (lineStarts[nextStartLine] ?? text.length);
  });
}

export interface TopLevelBlockInfo {
  type: string;
  startOffset: number;
  endOffset: number;
  source: string;
}

/** Return the top-level block enclosing `offset`, including its source slice. */
export function topLevelBlockAt(text: string, offset: number): TopLevelBlockInfo | null {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const tokens = md.parse(text, {});
  const blocks = tokens.filter((t) => t.level === 0 && t.map !== null);
  for (const block of blocks) {
    const startOffset = lineStarts[block.map![0]] ?? 0;
    const endOffset = lineStarts[block.map![1]] ?? text.length;
    if (offset >= startOffset && offset <= endOffset) {
      return {
        type: block.type,
        startOffset,
        endOffset,
        source: text.slice(startOffset, endOffset),
      };
    }
  }
  return null;
}
function getInlineSignature(source: string): string[] {
  const tokens = md.parse(source, {});
  const inline = tokens.find((t) => t.type === "inline");
  if (!inline || !inline.children) return [];
  const sig: string[] = [];
  for (const c of inline.children) {
    if (c.type === "text" || c.type === "softbreak") continue;
    if (c.type === "link_open") {
      sig.push(`link_open:${c.info || ""}:${JSON.stringify(c.attrs || [])}`);
    } else if (c.type === "link_close") {
      sig.push(`link_close:${c.info || ""}`);
    } else if (c.type === "code_inline" || c.type === "image" || c.type === "html_inline") {
      sig.push(`${c.type}:${c.content}:${JSON.stringify(c.attrs || [])}`);
    } else {
      sig.push(c.type);
    }
  }
  return sig;
}

/** Check whether `offsetInBlock` inside a paragraph block lands at a safe top-level
 *  text position rather than severing an active inline construct (code span,
 *  emphasis, strong, link label/delimiter, strikethrough, image, hardbreak, etc.).
 *  Compares the inline structural signature of the full block against the concatenated
 *  signatures of the prefix and suffix parsed independently; if any construct crosses
 *  the boundary, their structures diverge and this returns false.
 */
export function isSafeInlineParagraphOffset(paragraphSource: string, offsetInBlock: number): boolean {
  if (offsetInBlock < 0 || offsetInBlock > paragraphSource.length) return false;
  const prefix = paragraphSource.slice(0, offsetInBlock);
  const suffix = paragraphSource.slice(offsetInBlock);

  const fullSig = getInlineSignature(paragraphSource);
  const prefixSig = getInlineSignature(prefix);
  const suffixSig = getInlineSignature(suffix);
  const combinedSig = [...prefixSig, ...suffixSig];

  if (fullSig.length !== combinedSig.length) return false;
  for (let i = 0; i < fullSig.length; i += 1) {
    if (fullSig[i] !== combinedSig[i]) return false;
  }
  return true;
}

/** Render markdown to sanitized, XSS-safe HTML. */
export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}): string {
  // Heal unterminated markup first (streaming), then run table normalization so it
  // sees correct fence state, then parse.
  const healed = options.streaming ? remend(text) : text;
  const source = normalizeMarkdownTables(healed);
  const rawHtml = md.render(source);
  return DOMPurify.sanitize(rawHtml);
}
