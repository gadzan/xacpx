// tests/unit/packages/relay-protocol/validate-primitives.test.ts
import { expect, test } from "bun:test";
import { isObj, isStr, optStr, optNum, optBool } from "../../../../packages/relay-protocol/src/validate-primitives";

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
