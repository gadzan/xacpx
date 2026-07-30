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

/** Render markdown to sanitized, XSS-safe HTML. */
export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}): string {
  // Heal unterminated markup first (streaming), then run table normalization so it
  // sees correct fence state, then parse.
  const healed = options.streaming ? remend(text) : text;
  const source = normalizeMarkdownTables(healed);
  const rawHtml = md.render(source);
  return DOMPurify.sanitize(rawHtml);
}
