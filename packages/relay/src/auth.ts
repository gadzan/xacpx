import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url — used for invites, pairing tokens, credentials, web sessions. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are stored hashed at rest; sha256 suffices for high-entropy random tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two equal-length hex hash strings. */
export function hashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
