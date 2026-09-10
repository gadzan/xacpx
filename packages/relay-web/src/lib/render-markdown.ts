import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
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

/** Apply the exact source preprocessing used before every markdown-it render. */
export function preprocessMarkdownSource(
  text: string,
  options: RenderMarkdownOptions = {},
): string {
  const healed = options.streaming ? remend(text) : text;
  return normalizeMarkdownTables(healed);
}

/** Parse one inline Markdown stream with the same parser and document env as full rendering. */
export function parseMarkdownInline(
  source: string,
  env: Record<string, unknown> = {},
): Token[] {
  const inline = md.parseInline(source, env).find((token) => token.type === "inline");
  return inline?.children ?? [];
}

/** Render a token fragment as one paragraph through the shared sanitizer. */
export function renderMarkdownInlineFragment(
  tokens: Token[],
  env: Record<string, unknown> = {},
): string {
  const inner = md.renderer.renderInline(tokens, md.options, env);
  return DOMPurify.sanitize(`<p>${inner}</p>`);
}

export interface TopLevelBlockInfo {
  type: string;
  startOffset: number;
  endOffset: number;
  source: string;
  inlineSource: string | null;
  tokens: Token[];
}

export interface MarkdownDocumentAnalysis {
  boundaries: number[];
  blocks: TopLevelBlockInfo[];
  env: Record<string, unknown>;
}

/** Parse a Markdown document once and retain all top-level block ranges plus the
 * document env populated by markdown-it (notably reference link definitions).
 * Gaps between blocks stay attached to the preceding boundary, so activity after
 * "\n\n" lands before the next block.
 */
export function analyzeMarkdownDocument(
  text: string,
  env: Record<string, unknown> = {},
): MarkdownDocumentAnalysis {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }

  const tokens = md.parse(text, env);
  const topLevelEntries = tokens
    .map((token, tokenIndex) => ({ token, tokenIndex }))
    .filter(({ token }) => token.level === 0 && token.map !== null)
    .filter(({ token }, index, all) =>
      index === 0
      || token.map![0] !== all[index - 1]!.token.map![0]
      || token.map![1] !== all[index - 1]!.token.map![1],
    );
  const blocks = topLevelEntries.map(({ token, tokenIndex }, index): TopLevelBlockInfo => {
    const startOffset = lineStarts[token.map![0]] ?? 0;
    const endOffset = lineStarts[token.map![1]] ?? text.length;
    const blockTokens = tokens.slice(
      tokenIndex,
      topLevelEntries[index + 1]?.tokenIndex ?? tokens.length,
    );
    return {
      type: token.type,
      startOffset,
      endOffset,
      source: text.slice(startOffset, endOffset),
      inlineSource: blockTokens.find((blockToken) => blockToken.type === "inline")?.content ?? null,
      tokens: blockTokens,
    };
  });
  const boundaries = blocks.length === 0 ? [text.length] : blocks.map((_, index) => {
    const nextStartLine = topLevelEntries[index + 1]?.token.map![0];
    return nextStartLine === undefined
      ? text.length
      : (lineStarts[nextStartLine] ?? text.length);
  });

  return { boundaries, blocks, env };
}

/** Render already-parsed block tokens in their original document environment. */
export function renderMarkdownTokens(
  tokens: Token[],
  env: Record<string, unknown> = {},
): string {
  return DOMPurify.sanitize(md.renderer.render(tokens, md.options, env));
}

/** Render markdown to sanitized, XSS-safe HTML. */
export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}): string {
  const source = preprocessMarkdownSource(text, options);
  const rawHtml = md.render(source);
  return DOMPurify.sanitize(rawHtml);
}
