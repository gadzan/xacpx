import { expect, test } from "bun:test";

import {
  isEffectConcurrencySafe,
  requiresSingleWriterSlot,
} from "../../../src/conversations/conversation-filesystem-policy";

test("shared-single-writer serializes unknown and mutating turns, allows proven read-only", () => {
  expect(isEffectConcurrencySafe(undefined, "shared-single-writer", 1)).toBe(false);
  expect(isEffectConcurrencySafe("unknown", "shared-single-writer", 1)).toBe(false);
  expect(isEffectConcurrencySafe("mutating", "shared-single-writer", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "shared-single-writer", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "shared-single-writer", 1, "declared-enforced")).toBe(true);
  expect(isEffectConcurrencySafe("mutating", "shared-single-writer", 0)).toBe(true);
});

test("shared also serializes unproven turns; only proven read-only overlaps on any tree", () => {
  // No isolation passes unproven work through: PR7 persists every explicit
  // member as `unknown` (no enforceable read-only proof exists), so every
  // PR7 Group member serializes regardless of isolation. `shared` keeps its
  // distinct policy value for a future capability-enforced caller, but the
  // scheduler treats it like every other tree until such proof exists.
  expect(isEffectConcurrencySafe("read-only", "shared", 2)).toBe(false);
  expect(isEffectConcurrencySafe("mutating", "shared", 2)).toBe(false);
  expect(isEffectConcurrencySafe("unknown", "shared", 2)).toBe(false);
  expect(isEffectConcurrencySafe(undefined, "shared", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "shared", 2, "declared-enforced")).toBe(true);
  expect(isEffectConcurrencySafe("mutating", "shared", 0)).toBe(true);
  expect(isEffectConcurrencySafe("unknown", "worktree-per-member", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "worktree-per-member", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "worktree-per-member", 1, "declared-enforced")).toBe(true);
});

test("single-writer slot is required for anything not proven read-only on every isolation", () => {
  expect(requiresSingleWriterSlot(undefined, "shared-single-writer")).toBe(true);
  expect(requiresSingleWriterSlot("mutating", "shared-single-writer")).toBe(true);
  expect(requiresSingleWriterSlot("read-only", "shared-single-writer")).toBe(true);
  expect(requiresSingleWriterSlot("read-only", "shared-single-writer", "declared-enforced")).toBe(false);
  expect(requiresSingleWriterSlot("mutating", "shared")).toBe(true);
  expect(requiresSingleWriterSlot("unknown", "shared")).toBe(true);
  expect(requiresSingleWriterSlot("read-only", "shared")).toBe(true);
  expect(requiresSingleWriterSlot("read-only", "shared", "declared-enforced")).toBe(false);
});

test("bare read-only without the enforced proof still serializes", () => {
  // The fail-closed seam: effect alone never bypasses the writer slot.
  expect(isEffectConcurrencySafe("read-only", "shared-single-writer", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "shared-single-writer", 1, undefined)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "worktree-per-member", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "shared-single-writer", 1, "declared-enforced")).toBe(true);
  expect(isEffectConcurrencySafe("read-only", "worktree-per-member", 1, "declared-enforced")).toBe(true);
  expect(isEffectConcurrencySafe("unknown", "shared-single-writer", 1, "declared-enforced")).toBe(false);
  // `shared` never exempts unproven work: without enforced proof even a
  // declared read-only turn serializes there too.
  expect(isEffectConcurrencySafe("read-only", "shared", 1)).toBe(false);
  expect(isEffectConcurrencySafe("read-only", "shared", 1, "declared-enforced")).toBe(true);
});
