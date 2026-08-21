import { encodeAgentHandle } from "./agent-handle";
import type { AgentMessageCompletion } from "./agent-messaging-types";

export const MAX_PEER_COMPLETION_RESULT_BYTES = 16 * 1024;
export const TRUNCATION_MARKER = "\n[xacpx: result truncated]";
const MAX_ERROR_CHARS = 500;

export function boundPeerResult(
  text: string,
  maxBytes = MAX_PEER_COMPLETION_RESULT_BYTES,
): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  const markerBuf = Buffer.from(TRUNCATION_MARKER, "utf8");
  const maxBodyBytes = Math.max(0, maxBytes - markerBuf.byteLength);

  let end = maxBodyBytes;
  // If end lands in the middle of a multi-byte UTF-8 sequence, back up to the leading byte
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  // Now end is at the start of a UTF-8 character. Check if that character fits.
  if (end > 0) {
    const lead = buf[end]!;
    let charLen = 1;
    if ((lead & 0xe0) === 0xc0) charLen = 2;
    else if ((lead & 0xf0) === 0xe0) charLen = 3;
    else if ((lead & 0xf8) === 0xf0) charLen = 4;

    if (end + charLen > maxBodyBytes) {
      // Incomplete character at the cut boundary; do not include it
    } else {
      end = end + charLen;
    }
  }

  const truncatedText = buf.subarray(0, end).toString("utf8");
  return truncatedText + TRUNCATION_MARKER;
}

export function sanitizeCompletionError(
  err: string,
  maxChars = MAX_ERROR_CHARS,
): string {
  if (!err) {
    return "Peer turn failed";
  }
  // Strip stack trace lines (e.g. lines starting with "at ...")
  const lines = err
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("at "));

  let clean = lines.join(" ").trim();
  if (!clean) {
    clean = "Peer turn failed";
  }
  if (clean.length > maxChars) {
    clean = clean.slice(0, maxChars - 3) + "...";
  }
  return clean;
}

export function disarmUserDirectiveTags(text: string): string {
  return text
    .replace(/<(\/?)xacpx-([^>]*)>/gi, "&lt;$1xacpx-$2&gt;")
    .replace(/<(\/?)xacpx-/gi, "&lt;$1xacpx-");
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildPeerCompletionPrompt(
  completion: AgentMessageCompletion,
): string {
  let fromHandle: string;
  try {
    fromHandle = encodeAgentHandle(completion.from);
  } catch {
    fromHandle = `${completion.from.nodeId}:${completion.from.endpointId}`;
  }
  const isResultMode =
    completion.status === "completed" && completion.result !== undefined;
  if (isResultMode) {
    const attributePairs: Array<[string, string]> = [
      ["request-id", completion.requestMessageId],
      ["from", fromHandle],
      ["status", "completed"],
    ];
    const attributes = attributePairs
      .map(([name, value]) => `${name}="${escapeXml(value)}"`)
      .join(" ");

    const escapedResult = escapeXml(completion.result ?? "");
    return [
      `<xacpx-peer-result ${attributes}>`,
      escapedResult,
      `</xacpx-peer-result>`,
      "",
      "<instruction>",
      "  This is the terminal outcome of a peer request initiated by this session.",
      "  Do NOT send an acknowledgement or confirmation message back to the peer.",
      "  Use this result to continue the current user task.",
      "  Contact the peer again only if you need new, substantive information.",
      "</instruction>",
    ].join("\n");
  }

  const attributePairs: Array<[string, string]> = [
    ["request-id", completion.requestMessageId],
    ["from", fromHandle],
    ["status", completion.status],
  ];
  if (completion.error) {
    attributePairs.push(["error", sanitizeCompletionError(completion.error)]);
  }
  const attributes = attributePairs
    .map(([name, value]) => `${name}="${escapeXml(value)}"`)
    .join(" ");

  return [
    `<xacpx-peer-completion ${attributes}>`,
    `</xacpx-peer-completion>`,
    "",
    "<instruction>",
    "  This is the terminal outcome of a peer request initiated by this session.",
    "  Do NOT send an acknowledgement or confirmation message back to the peer.",
    "  Use this information to continue the current user task.",
    "  Contact the peer again only if you need new, substantive information.",
    "</instruction>",
  ].join("\n");
}
