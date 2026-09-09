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

/** Apply the exact source preprocessing used before every markdown-it render. */
export function preprocessMarkdownSource(
  text: string,
  options: RenderMarkdownOptions = {},
): string {
  const healed = options.streaming ? remend(text) : text;
  return normalizeMarkdownTables(healed);
}

export interface TopLevelBlockInfo {
  type: string;
  startOffset: number;
  endOffset: number;
  source: string;
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

  const topLevelTokens = md
    .parse(text, env)
    .filter((token) => token.level === 0 && token.map !== null)
    .filter((token, index, all) =>
      index === 0
      || token.map![0] !== all[index - 1]!.map![0]
      || token.map![1] !== all[index - 1]!.map![1],
    );
  const blocks = topLevelTokens.map((token): TopLevelBlockInfo => {
    const startOffset = lineStarts[token.map![0]] ?? 0;
    const endOffset = lineStarts[token.map![1]] ?? text.length;
    return {
      type: token.type,
      startOffset,
      endOffset,
      source: text.slice(startOffset, endOffset),
    };
  });
  const boundaries = blocks.length === 0 ? [text.length] : blocks.map((_, index) => {
    const nextStartLine = topLevelTokens[index + 1]?.map![0];
    return nextStartLine === undefined
      ? text.length
      : (lineStarts[nextStartLine] ?? text.length);
  });

  return { boundaries, blocks, env };
}

/**
 * Return source offsets where a top-level Markdown block can safely hand over to
 * non-Markdown turn activity. Parsing the raw source is intentionally conservative:
 * normalization may recognize more constructs, but it must never create an unsafe
 * split inside the original source.
 */
export function markdownBlockBoundaries(text: string): number[] {
  return analyzeMarkdownDocument(text).boundaries;
}

/** Return the top-level block enclosing `offset`, including its source slice.
 *  Accepts an optional markdown-it `env` object that collects document-level
 *  metadata (such as reference link definitions) during the parse.
 */
export function topLevelBlockAt(
  text: string,
  offset: number,
  env: Record<string, unknown> = {},
): TopLevelBlockInfo | null {
  return analyzeMarkdownDocument(text, env).blocks.find(
    (block) => offset >= block.startOffset && offset <= block.endOffset,
  ) ?? null;
}

interface SemanticInlineToken {
  type: string;
  content: string;
  attrs: string;
  info: string;
}

function canonicalInlineTokens(source: string, env: Record<string, unknown>): SemanticInlineToken[] {
  const tokens = md.parseInline(source, { ...env });
  const inline = tokens.find((t) => t.type === "inline");
  if (!inline || !inline.children) return [];

  const result: SemanticInlineToken[] = [];
  for (const c of inline.children) {
    if (c.type === "softbreak") {
      if (result.length > 0 && result[result.length - 1]!.type === "text") {
        result[result.length - 1]!.content += "\n";
      } else {
        result.push({ type: "text", content: "\n", attrs: "", info: "" });
      }
      continue;
    }
    if (c.type === "text") {
      if (result.length > 0 && result[result.length - 1]!.type === "text") {
        result[result.length - 1]!.content += c.content;
      } else {
        result.push({ type: "text", content: c.content, attrs: "", info: "" });
      }
      continue;
    }
    result.push({
      type: c.type,
      content: c.content || "",
      attrs: c.attrs ? JSON.stringify(c.attrs) : "",
      info: c.info || "",
    });
  }
  return result;
}

function mergeTokenStreams(a: SemanticInlineToken[], b: SemanticInlineToken[]): SemanticInlineToken[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const merged = [...a];
  const lastA = merged[merged.length - 1]!;
  const firstB = b[0]!;
  if (lastA.type === "text" && firstB.type === "text") {
    merged[merged.length - 1] = {
      ...lastA,
      content: lastA.content + firstB.content,
    };
    merged.push(...b.slice(1));
  } else {
    merged.push(...b);
  }
  return merged;
}

function areSemanticTokensEqual(a: SemanticInlineToken[], b: SemanticInlineToken[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i]!.type !== b[i]!.type ||
      a[i]!.content !== b[i]!.content ||
      a[i]!.attrs !== b[i]!.attrs ||
      a[i]!.info !== b[i]!.info
    ) {
      return false;
    }
  }
  return true;
}

function isStandaloneParagraph(source: string): boolean {
  if (!source.trim()) return true;
  const blocks = md
    .parse(source, {})
    .filter((token) => token.level === 0 && token.map !== null);
  return blocks.length === 1 && blocks[0]!.type === "paragraph_open";
}

function preprocessingPreservesSource(source: string, streaming: boolean): boolean {
  if (preprocessMarkdownSource(source) !== source) return false;
  return !streaming || preprocessMarkdownSource(source, { streaming: true }) === source;
}

/** Check whether `offsetInBlock` inside a paragraph block lands at a safe top-level
 *  text position rather than severing an active inline construct (code span,
 *  emphasis, strong, link label/delimiter, reference link, HTML entity, hardbreak, etc.).
 *  Compares the canonical inline semantic tokens of the full block against the concatenated
 *  tokens of the prefix and suffix parsed independently within the same document env.
 *  Adjacent text tokens across the slice boundary are merged so normal prose splits match;
 *  if any inline construct or entity was severed, their token streams diverge and this returns false.
 */
export function isSafeInlineParagraphOffset(
  paragraphSource: string,
  offsetInBlock: number,
  env: Record<string, unknown> = {},
): boolean {
  if (offsetInBlock < 0 || offsetInBlock > paragraphSource.length) return false;
  const prefix = paragraphSource.slice(0, offsetInBlock);
  const suffix = paragraphSource.slice(offsetInBlock);

  const fullTokens = canonicalInlineTokens(paragraphSource, env);
  const prefixTokens = canonicalInlineTokens(prefix, env);
  const suffixTokens = canonicalInlineTokens(suffix, env);
  const combinedTokens = mergeTokenStreams(prefixTokens, suffixTokens);

  return areSemanticTokensEqual(fullTokens, combinedTokens);
}

/** Check a paragraph split as it will actually render in TurnParts: preprocessing
 * must preserve the full paragraph and both standalone fragments, the full paragraph
 * resolves against its document env, and the fragments parse with isolated env objects.
 * This rejects preprocessing-created block semantics and document-context dependencies
 * while still allowing ordinary prose in an earlier block to interleave with activity.
 */
export function isSafeStandaloneParagraphOffset(
  paragraphSource: string,
  offsetInBlock: number,
  documentEnv: Record<string, unknown> = {},
  options: RenderMarkdownOptions = {},
): boolean {
  if (offsetInBlock < 0 || offsetInBlock > paragraphSource.length) return false;
  const prefix = paragraphSource.slice(0, offsetInBlock);
  const suffix = paragraphSource.slice(offsetInBlock);
  const streaming = options.streaming === true;
  if (
    !preprocessingPreservesSource(paragraphSource, streaming)
    || !preprocessingPreservesSource(prefix, streaming)
    || !preprocessingPreservesSource(suffix, streaming)
  ) return false;
  if (!isStandaloneParagraph(prefix) || !isStandaloneParagraph(suffix)) return false;

  const fullTokens = canonicalInlineTokens(paragraphSource, documentEnv);
  const prefixTokens = canonicalInlineTokens(prefix, {});
  const suffixTokens = canonicalInlineTokens(suffix, {});
  const combinedTokens = mergeTokenStreams(prefixTokens, suffixTokens);

  return areSemanticTokensEqual(fullTokens, combinedTokens);
}

/** Render markdown to sanitized, XSS-safe HTML. */
export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}): string {
  const source = preprocessMarkdownSource(text, options);
  const rawHtml = md.render(source);
  return DOMPurify.sanitize(rawHtml);
}
