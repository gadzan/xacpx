/**
 * Discord error classification helpers.
 */

export type DiscordErrorKind = "retryable" | "fatal" | "permission" | "unknown";

const PERMISSION_CODES = new Set([50001, 50013, 50007, 50008]);

export function classifyDiscordError(error: unknown): DiscordErrorKind {
  const code = extractDiscordApiCode(error);
  if (code !== undefined) {
    if (PERMISSION_CODES.has(code)) return "permission";
    if (code === 429) return "retryable";
    if (code >= 500 && code < 600) return "retryable";
  }
  const status = extractHttpStatus(error);
  if (status !== undefined) {
    if (status === 429) return "retryable";
    if (status === 403) return "permission";
    if (status >= 500) return "retryable";
    if (status >= 400 && status < 500) return "fatal";
  }
  if (isRateLimitError(error)) return "retryable";
  return "unknown";
}

export function extractDiscordApiCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const rec = error as { code?: unknown; status?: unknown; rawError?: { code?: unknown } };
  if (typeof rec.code === "number") return rec.code;
  if (rec.rawError && typeof rec.rawError.code === "number") return rec.rawError.code;
  return undefined;
}

export function extractHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const rec = error as { status?: unknown; httpStatus?: unknown; response?: { status?: unknown } };
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.httpStatus === "number") return rec.httpStatus;
  const nested = rec.response?.status;
  if (typeof nested === "number") return nested;
  return undefined;
}

export function extractDiscordMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const rec = error as { message?: unknown; rawError?: { message?: unknown } };
  if (typeof rec.message === "string") return rec.message;
  if (rec.rawError && typeof rec.rawError.message === "string") return rec.rawError.message;
  return "";
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const rec = error as { message?: unknown; name?: unknown };
  const msg = typeof rec.message === "string" ? rec.message.toLowerCase() : "";
  const name = typeof rec.name === "string" ? rec.name.toLowerCase() : "";
  return msg.includes("rate limit") || msg.includes("429") || name.includes("ratelimit");
}

export function isDiscordNotFoundError(error: unknown): boolean {
  const code = extractDiscordApiCode(error);
  if (code === 10003 || code === 10008) return true;
  const status = extractHttpStatus(error);
  return status === 404;
}

export function isDiscordArchivedThreadError(error: unknown): boolean {
  const code = extractDiscordApiCode(error);
  // 50083: Archived threads cannot be modified / cannot send in archived thread variants
  return code === 50083;
}
