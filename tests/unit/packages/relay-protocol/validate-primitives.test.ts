// tests/unit/packages/relay-protocol/validate-primitives.test.ts
import { expect, test } from "bun:test";
import {
  isObj,
  isStr,
  optStr,
  optNum,
  optBool,
  parseCanonicalBase64,
} from "../../../../packages/relay-protocol/src/validate-primitives";

function withGlobals<T>(
  overrides: Record<string, unknown>,
  fn: () => T,
): T {
  const previous = Object.entries(overrides).map(([key, value]) => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    return { key, desc };
  });
  try {
    return fn();
  } finally {
    for (const { key, desc } of previous) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test("isObj accepts plain objects, rejects null and non-objects", () => {
  expect(isObj({})).toBe(true);
  expect(isObj({ a: 1 })).toBe(true);
  expect(isObj(null)).toBe(false);
  expect(isObj(undefined)).toBe(false);
  expect(isObj("x")).toBe(false);
  expect(isObj(3)).toBe(false);
});

test("isStr is true only for strings", () => {
  expect(isStr("")).toBe(true);
  expect(isStr("a")).toBe(true);
  expect(isStr(1)).toBe(false);
  expect(isStr(undefined)).toBe(false);
});

test("optStr allows undefined or string, rejects other types", () => {
  expect(optStr(undefined)).toBe(true);
  expect(optStr("a")).toBe(true);
  expect(optStr(null)).toBe(false);
  expect(optStr(1)).toBe(false);
});

test("optNum allows undefined or number", () => {
  expect(optNum(undefined)).toBe(true);
  expect(optNum(2)).toBe(true);
  expect(optNum("2")).toBe(false);
});

test("optBool allows undefined or boolean", () => {
  expect(optBool(undefined)).toBe(true);
  expect(optBool(true)).toBe(true);
  expect(optBool(0)).toBe(false);
});

test("parseCanonicalBase64 works when global Buffer is unavailable", () => {
  const decoded = withGlobals({ Buffer: undefined }, () => parseCanonicalBase64("aGVsbG8=", 16));
  expect(decoded).not.toBeNull();
  expect(new TextDecoder().decode(decoded!)).toBe("hello");
});

test("parseCanonicalBase64 falls back to Buffer when atob/btoa are unavailable", () => {
  const decoded = withGlobals({ atob: undefined, btoa: undefined }, () =>
    parseCanonicalBase64("aGVsbG8=", 16),
  );
  expect(decoded).not.toBeNull();
  expect(new TextDecoder().decode(decoded!)).toBe("hello");
});

test("parseCanonicalBase64 returns null when no decoder is available", () => {
  expect(
    withGlobals({ Buffer: undefined, atob: undefined, btoa: undefined }, () =>
      parseCanonicalBase64("aGVsbG8=", 16),
    ),
  ).toBeNull();
});
