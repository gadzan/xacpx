/**
 * Discord 2000-char chunker with fence awareness and line-limit soft cap.
 *
 * - Hard limit: 2000 chars per chunk
 * - Soft limit: 17 lines per chunk (Discord collapses tall messages)
 * - Fence balancing: if a fenced block is cut, close it in current chunk and reopen in next
 */

export interface ChunkOptions {
  maxChars?: number; // default 2000
  maxLines?: number; // default 17
  preserveWhitespace?: boolean;
}

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_LINES = 17;

// Match opening fence line: ```lang\n
const FENCE_OPEN_RE = /^```[^\n]*\n?$/;
const FENCE_MARKER = "```";

function isFenceLine(line: string): boolean {
  return line.trimStart().startsWith(FENCE_MARKER);
}

function fenceLanguage(line: string): string {
  const trimmed = line.trimStart().slice(3).trim();
  // language hint is first word before space
  return trimmed.split(/\s+/)[0] ?? "";
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export function chunkDiscordText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  if (!text) return [];
  if (text.length <= maxChars && countLines(text) <= maxLines) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = 0;
  let currentLines = 0;
  let openFenceLang: string | null = null;

  const flush = (): void => {
    if (current.length === 0) return;
    let chunk = current.join("\n");
    // Close open fence at chunk boundary.
    if (openFenceLang !== null) {
      chunk += `\n${FENCE_MARKER}`;
    }
    chunks.push(chunk);
    // Next chunk reopens fence if needed.
    if (openFenceLang !== null) {
      const hint = openFenceLang ? `${FENCE_MARKER}${openFenceLang}` : FENCE_MARKER;
      current = [hint];
      currentChars = hint.length;
      currentLines = 1;
    } else {
      current = [];
      currentChars = 0;
      currentLines = 0;
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const isFence = isFenceLine(line);

    // Handle fence open/close tracking. Fence lines themselves toggle state.
    if (isFence) {
      const lang = fenceLanguage(line);
      // If we are opening a fence, record language.
      if (openFenceLang === null) {
        openFenceLang = lang;
      } else {
        // Closing fence
        openFenceLang = null;
      }
    }

    // Single line too long: split by maxChars
    if (line.length > maxChars) {
      // Flush current first if not empty
      if (current.length > 0) flush();

      // Split long line into segments.
      // Preserve fence context: each segment stays inside fence if open.
      const segments = splitLongLine(line, maxChars, openFenceLang);
      for (let s = 0; s < segments.length; s++) {
        const seg = segments[s]!;
        // For first segment, account for ongoing fence reopen already in current if needed.
        // Simplest: push segments directly as chunks (with fence wrapping already done via openFenceLang logic)
        if (current.length === 1 && openFenceLang !== null && current[0]!.startsWith(FENCE_MARKER)) {
          // current holds reopened fence line; append segment to it if fits
          const tentative = `${current[0]}\n${seg}`;
          if (tentative.length <= maxChars) {
            current.push(seg);
            currentChars = tentative.length;
            currentLines += 1;
            continue;
          } else {
            // flush fence-only line first
            flush();
          }
        }
        if (s === segments.length - 1 && openFenceLang !== null) {
          // Last segment: keep in current for next lines to append (don't flush yet)
          // But ensure it has fence open/close handling via flush later.
          // We need to add segment plus maintain fence reopen semantics.
          // Push segment to current (which may be empty after flush)
          const needed = seg.length + (current.length > 0 ? 1 : 0);
          if (currentChars + needed > maxChars) flush();
          if (current.length === 0 && openFenceLang !== null) {
            // Need to reopen fence if we flushed and still inside fence
            // Actually splitLongLine already accounted? For inner fence segments, we treat them as content
            // So we ensure current starts with reopen if needed and empty.
            const hint = openFenceLang ? `${FENCE_MARKER}${openFenceLang}` : FENCE_MARKER;
            // Only add hint if not already added
            if (openFenceLang !== null) {
              current.push(hint);
              currentChars = hint.length;
              currentLines = 1;
            }
          }
          current.push(seg);
          currentChars += (current.length > 1 ? 1 : 0) + seg.length;
          currentLines += 1;
        } else {
          // Middle segments: emit as standalone chunks with fence wrapping
          if (openFenceLang !== null) {
            const hint = openFenceLang ? `${FENCE_MARKER}${openFenceLang}` : FENCE_MARKER;
            chunks.push(`${hint}\n${seg}\n${FENCE_MARKER}`);
          } else {
            chunks.push(seg);
          }
        }
      }
      continue;
    }
    const addLen = line.length + (current.length > 0 ? 1 : 0); // +1 for \n
    const fenceReserve = openFenceLang !== null ? 4 : 0; // \n```
    const wouldExceedChars = currentChars + addLen + fenceReserve > maxChars;
    const wouldExceedLines = currentLines + 1 > maxLines;
    if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
      flush();
    }

    // After flush, current may contain reopened fence line.
    // Now add the line.
    // If current is empty and we are inside a fence, we need to ensure reopen was added;
    // flush() already did that, but if current was empty before flush and we didn't flush, we may need to handle.
    if (current.length === 0 && openFenceLang !== null && !isFence) {
      // Need fence reopen at start of chunk (flush already handles when flushing; but if we didn't flush this is first line of document inside fence)
      // Actually first chunk's opening fence is already in current if fence was opened earlier.
      // No extra action needed.
    }

    current.push(line);
    currentChars += addLen;
    currentLines += 1;
  }

  if (current.length > 0) {
    // If still inside fence, close it. But if last chunk is just a reopen hint with no content, drop it.
    if (current.length === 1 && openFenceLang !== null && current[0]!.startsWith(FENCE_MARKER)) {
      // Empty fenced chunk — discard
    } else {
      let chunk = current.join("\n");
      if (openFenceLang !== null) {
        chunk += `\n${FENCE_MARKER}`;
      }
      chunks.push(chunk);
    }
  }

  return chunks.filter((c) => c.length > 0);
}
function splitLongLine(line: string, maxChars: number, openFenceLang: string | null): string[] {
  const segments: string[] = [];
  let pos = 0;
  // Inside a fence, middle segments are wrapped as `${hint}\n${seg}\n``` ` (hint = ``` or ```lang),
  // so reserve hint+5 (\n + \n``` ) to keep every emitted chunk ≤ maxChars (FDEE:137-138 polish).
  const fenceOverhead = openFenceLang !== null ? (openFenceLang ? 3 + openFenceLang.length : 3) + 1 + 1 + 3 : 0;
  const effectiveMax = Math.max(1, maxChars - fenceOverhead);
  while (pos < line.length) {
    const end = Math.min(pos + effectiveMax, line.length);
    segments.push(line.slice(pos, end));
    pos = end;
  }
  return segments;
}
