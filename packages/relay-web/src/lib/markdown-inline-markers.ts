import type Token from "markdown-it/lib/token.mjs";
import {
  markdownTokensToPlainText,
  parseMarkdownInline,
  preprocessMarkdownSource,
  renderMarkdownInlineFragment,
  type RenderMarkdownOptions,
} from "./render-markdown";

const MARKER_OPEN = "\uE000";
const MARKER_CLOSE = "\uE001";
let nextMarkerNonce = 0;

export interface InlineActivityMarker {
  id: string;
  offset: number;
}

export interface InlineMarkdownFragment {
  sourceRange: [number, number];
  source: string;
  html: string;
  /**
   * Standalone copy representation derived from the fragment's own inline
   * tokens (text/code content, breaks as newlines, markup delimiters dropped),
   * so copying a fragment cut out of an inline construct never ships a
   * dangling `**`, backtick, or link destination.
   */
  copyText: string;
}

export interface InlineMarkerPlan {
  fragments: InlineMarkdownFragment[];
  activityIds: string[];
}

interface EncodedMarker extends InlineActivityMarker {
  encoded: string;
}

interface SemanticToken {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  attrs: string;
  markup: string;
  info: string;
}

function cloneToken(token: Token, overrides: Partial<Token> = {}): Token {
  return Object.assign(
    Object.create(Object.getPrototypeOf(token)) as Token,
    token,
    {
      attrs: token.attrs?.map(([name, value]) => [name, value] as [string, string]) ?? null,
      children: token.children ? [...token.children] : null,
    },
    overrides,
  );
}

function encodeMarkers(markers: readonly InlineActivityMarker[]): EncodedMarker[] | null {
  const seen = new Set<string>();
  let previousOffset = -1;
  for (const marker of markers) {
    if (marker.offset < previousOffset || seen.has(marker.id)) return null;
    previousOffset = marker.offset;
    seen.add(marker.id);
  }
  const nonce = (nextMarkerNonce++).toString(36);
  return markers.map((marker, index) => ({
    ...marker,
    encoded: `${MARKER_OPEN}${nonce}.${index.toString(36)}${MARKER_CLOSE}`,
  }));
}

function injectMarkers(source: string, markers: readonly EncodedMarker[]): string | null {
  if (source.includes(MARKER_OPEN) || source.includes(MARKER_CLOSE)) return null;
  let result = "";
  let cursor = 0;
  for (const marker of markers) {
    if (marker.offset < 0 || marker.offset > source.length) return null;
    result += source.slice(cursor, marker.offset);
    result += marker.encoded;
    cursor = marker.offset;
  }
  return result + source.slice(cursor);
}

function isInsideHtmlLikeSyntax(source: string, offset: number): boolean {
  const open = source.lastIndexOf("<", Math.max(0, offset - 1));
  const close = source.lastIndexOf(">", Math.max(0, offset - 1));
  return open > close && source.indexOf(">", offset) >= 0;
}
function markerToken(token: Token, marker: EncodedMarker): Token {
  return cloneToken(token, {
    type: "turn_activity_marker",
    tag: "",
    nesting: 0,
    content: marker.id,
    markup: "",
    info: "",
    attrs: null,
    children: null,
    meta: { activityId: marker.id, sourceOffset: marker.offset },
  });
}

function extractMarkerTokens(
  tokens: readonly Token[],
  markers: readonly EncodedMarker[],
): { tokens: Token[]; activityIds: string[] } {
  // Single linear scan: every encoded marker starts with MARKER_OPEN and ends
  // at the next MARKER_CLOSE, so one indexOf pair per occurrence finds the
  // next candidate and a Map lookup validates it. The previous version probed
  // every encoding at every position (O(markers) indexOf calls per hit).
  const byEncoding = new Map(markers.map((marker) => [marker.encoded, marker]));
  const result: Token[] = [];
  const activityIds: string[] = [];

  for (const token of tokens) {
    if (token.type !== "text" && token.type !== "code_inline") {
      result.push(token);
      continue;
    }
    let cursor = 0;
    let found = false;
    while (cursor < token.content.length) {
      const openIndex = token.content.indexOf(MARKER_OPEN, cursor);
      if (openIndex < 0) break;
      const closeIndex = token.content.indexOf(MARKER_CLOSE, openIndex + MARKER_OPEN.length);
      if (closeIndex < 0) break;
      const candidate = token.content.slice(openIndex, closeIndex + MARKER_CLOSE.length);
      const marker = byEncoding.get(candidate);
      if (!marker) break;
      found = true;
      if (openIndex > cursor) {
        result.push(cloneToken(token, { content: token.content.slice(cursor, openIndex) }));
      }
      result.push(markerToken(token, marker));
      activityIds.push(marker.id);
      cursor = openIndex + candidate.length;
    }
    if (!found) {
      result.push(token);
    } else if (cursor < token.content.length) {
      result.push(cloneToken(token, { content: token.content.slice(cursor) }));
    }
  }

  return { tokens: result, activityIds };
}

function semanticTokens(tokens: readonly Token[]): SemanticToken[] {
  const result: SemanticToken[] = [];
  for (const token of tokens) {
    if (token.type === "turn_activity_marker") continue;
    const semantic: SemanticToken = {
      type: token.type,
      tag: token.tag,
      nesting: token.nesting,
      content: token.content,
      attrs: token.attrs ? JSON.stringify(token.attrs) : "",
      markup: token.markup,
      info: token.info,
    };
    const previous = result[result.length - 1];
    if (
      previous
      && (semantic.type === "text" || semantic.type === "code_inline")
      && previous.type === semantic.type
      && previous.tag === semantic.tag
      && previous.nesting === semantic.nesting
      && previous.attrs === semantic.attrs
      && previous.markup === semantic.markup
      && previous.info === semantic.info
    ) {
      previous.content += semantic.content;
    } else {
      result.push(semantic);
    }
  }
  return result;
}

function semanticTokensEqual(left: readonly Token[], right: readonly Token[]): boolean {
  return JSON.stringify(semanticTokens(left)) === JSON.stringify(semanticTokens(right));
}

function syntheticClose(open: Token): Token {
  return cloneToken(open, {
    type: open.type.endsWith("_open")
      ? `${open.type.slice(0, -5)}_close`
      : open.type,
    nesting: -1,
    attrs: null,
  });
}

function hasRenderableContent(tokens: readonly Token[]): boolean {
  return tokens.some((token) =>
    token.nesting === 0
    && (token.type !== "text" || token.content.trim().length > 0),
  );
}

function fragmentCopyText(tokens: readonly Token[]): string {
  // Fragments reuse the single Copy contract: the fragment's own inline
  // stream (already synthetic-closed/reopened) serialized as plaintext.
  return markdownTokensToPlainText(tokens);
}

function splitAndRender(
  source: string,
  tokens: readonly Token[],
  markersById: ReadonlyMap<string, EncodedMarker>,
  env: Record<string, unknown>,
): InlineMarkerPlan | null {
  const fragments: InlineMarkdownFragment[] = [];
  const activityIds: string[] = [];
  const openStack: Token[] = [];
  let fragmentTokens: Token[] = [];
  let fragmentStart = 0;

  const pushFragment = (end: number): void => {
    if (end <= fragmentStart) return;
    const sourceFragment = source.slice(fragmentStart, end);
    fragments.push({
      sourceRange: [fragmentStart, end],
      source: sourceFragment,
      html: hasRenderableContent(fragmentTokens)
        ? renderMarkdownInlineFragment(fragmentTokens, env)
        : "",
      copyText: fragmentCopyText(fragmentTokens),
    });
  };

  for (const token of tokens) {
    if (token.type === "turn_activity_marker") {
      const marker = markersById.get(token.content);
      if (!marker) return null;
      fragmentTokens.push(...openStack.toReversed().map(syntheticClose));
      pushFragment(marker.offset);
      activityIds.push(marker.id);
      fragmentStart = marker.offset;
      fragmentTokens = openStack.map((open) => cloneToken(open));
      continue;
    }

    fragmentTokens.push(token);
    if (token.nesting === 1) {
      openStack.push(token);
    } else if (token.nesting === -1) {
      const open = openStack.pop();
      if (!open || open.tag !== token.tag) return null;
    }
  }

  if (openStack.length !== 0) return null;
  pushFragment(source.length);
  return { fragments, activityIds };
}

/**
 * Parse a complete paragraph with zero-width activity markers, prove that removing
 * those markers preserves the original semantic token stream, then materialize
 * independently valid HTML fragments by closing and reopening the active inline stack.
 */
export function planInlineActivityMarkers(
  paragraphSource: string,
  markers: readonly InlineActivityMarker[],
  documentEnv: Record<string, unknown> = {},
  options: RenderMarkdownOptions = {},
): InlineMarkerPlan | null {
  if (markers.length === 0) return null;
  if (markers.some((marker) => isInsideHtmlLikeSyntax(paragraphSource, marker.offset))) {
    return null;
  }
  const encodedMarkers = encodeMarkers(markers);
  if (!encodedMarkers) return null;
  const markedSource = injectMarkers(paragraphSource, encodedMarkers);
  if (markedSource === null) return null;

  const originalPrepared = preprocessMarkdownSource(paragraphSource, options);
  const markedPrepared = preprocessMarkdownSource(markedSource, options);
  const originalTokens = parseMarkdownInline(originalPrepared, { ...documentEnv });
  const markedTokens = parseMarkdownInline(markedPrepared, { ...documentEnv });
  const extracted = extractMarkerTokens(markedTokens, encodedMarkers);
  const expectedIds = markers.map((marker) => marker.id);
  if (
    extracted.activityIds.length !== expectedIds.length
    || extracted.activityIds.some((id, index) => id !== expectedIds[index])
    || !semanticTokensEqual(originalTokens, extracted.tokens)
  ) {
    return null;
  }

  return splitAndRender(
    paragraphSource,
    extracted.tokens,
    new Map(encodedMarkers.map((marker) => [marker.id, marker])),
    documentEnv,
  );
}
