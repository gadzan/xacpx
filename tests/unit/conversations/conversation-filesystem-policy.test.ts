import { expect, test } from "bun:test";

import {
  isEffectConcurrencySafe,
  requiresSingleWriterSlot,
} from "../../../src/conversations/conversation-filesystem-policy";

test("shared-single-writer serializes unknown and mutating turns, allows proven read-only", () => {
  expect(isEffectConcurrencySafe(undefined, "shared-single-writer", 1)).toBe(false);
  expect(isEffectConcurrencySafe("unknown", "shared-single-writer", 1)).toBe(false);
  expect(isEffectConcurrencySafe("mutating", "shared-single-writer", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "shared-single-writer", 1)).toBe(true);
  expect(isEffectConcurrencySafe("mutating", "shared-single-writer", 0)).toBe(true);
});

test("shared allows only proven read-only alongside in-flight turns; worktree defers to single-writer", () => {
  expect(isEffectConcurrencySafe("read-only", "shared", 2)).toBe(true);
  expect(isEffectConcurrencySafe("mutating", "shared", 2)).toBe(false);
  expect(isEffectConcurrencySafe("unknown", "shared", 2)).toBe(false);
  expect(isEffectConcurrencySafe(undefined, "shared", 1)).toBe(false);
  expect(isEffectConcurrencySafe("mutating", "shared", 0)).toBe(true);
  expect(isEffectConcurrencySafe("unknown", "worktree-per-member", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "worktree-per-member", 1)).toBe(true);
});

test("single-writer slot is required for anything not proven read-only on every isolation", () => {
  expect(requiresSingleWriterSlot(undefined, "shared-single-writer")).toBe(true);
  expect(requiresSingleWriterSlot("mutating", "shared-single-writer")).toBe(true);
  expect(requiresSingleWriterSlot("read-only", "shared-single-writer")).toBe(false);
  expect(requiresSingleWriterSlot("mutating", "shared")).toBe(true);
  expect(requiresSingleWriterSlot("unknown", "shared")).toBe(true);
  expect(requiresSingleWriterSlot("read-only", "shared")).toBe(false);
  expect(requiresSingleWriterSlot("mutating", "worktree-per-member")).toBe(true);
});
