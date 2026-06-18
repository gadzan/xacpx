import { expect, test } from "bun:test";

import { generateToken, hashToken } from "../../../../packages/relay/src/auth";

test("tokens are url-safe, unique, and hash deterministically", () => {
  const a = generateToken();
  const b = generateToken();
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(hashToken(a)).toBe(hashToken(a));
  expect(hashToken(a)).not.toBe(hashToken(b));
  expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
});
