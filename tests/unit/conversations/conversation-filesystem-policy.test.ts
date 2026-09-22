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

test("shared never serializes at this seam; worktree defers to single-writer until provisioned", () => {
  expect(isEffectConcurrencySafe("mutating", "shared", 2)).toBe(true);
  expect(isEffectConcurrencySafe("unknown", "worktree-per-member", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "worktree-per-member", 1)).toBe(true);
});

test("single-writer slot is required for anything not proven read-only outside shared", () => {
  expect(requiresSingleWriterSlot(undefined, "shared-single-writer")).toBe(true);
  expect(requiresSingleWriterSlot("mutating", "shared-single-writer")).toBe(true);
  expect(requiresSingleWriterSlot("read-only", "shared-single-writer")).toBe(false);
  expect(requiresSingleWriterSlot("mutating", "shared")).toBe(false);
  expect(requiresSingleWriterSlot("mutating", "worktree-per-member")).toBe(true);
});
