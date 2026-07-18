import { expect, test } from "vitest";
import {
  parseCssColor,
  relativeLuminance,
  contrastRatio,
  pickReadableTextColor,
} from "../lib/wcag-contrast";

test("parseCssColor parses rgb and fully-opaque rgba", () => {
  expect(parseCssColor("rgb(204, 204, 204)")).toEqual([204, 204, 204]);
  expect(parseCssColor("rgba(1, 2, 3, 1)")).toEqual([1, 2, 3]);
});

test("parseCssColor returns null for anything not a usable opaque color", () => {
  expect(parseCssColor("none")).toBeNull();
  expect(parseCssColor("")).toBeNull();
  expect(parseCssColor("rgba(0, 0, 0, 0)")).toBeNull(); // fully transparent
  // Non-opaque alpha can't be composited without the effective background — skip it
  // rather than measure the wrong (unblended) color and decide on it.
  expect(parseCssColor("rgba(1, 2, 3, 0.5)")).toBeNull();
  expect(parseCssColor("rgba(1, 2, 3, x)")).toBeNull(); // non-numeric alpha
});

test("relativeLuminance: black is 0, white is 1", () => {
  expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
  expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
});

test("contrastRatio matches the probe-measured anchors", () => {
  const text = parseCssColor("rgb(204, 204, 204)")!; // #ccc mermaid dark label
  const lightFill = parseCssColor("rgb(224, 255, 255)")!; // #e0ffff pinned
  const darkFill = parseCssColor("rgb(31, 32, 32)")!; // #1f2020 theme default
  expect(contrastRatio(text, lightFill)).toBeCloseTo(1.52, 1);
  expect(contrastRatio(text, darkFill)).toBeCloseTo(10.17, 1);
});

test("contrastRatio straddles the 3.0 label threshold at gray 148/149 (boundary anchors)", () => {
  // These grays bracket the MIN_LABEL_CONTRAST=3.0 decision in render-mermaid.ts:
  // white-on-gray(148) ≈ 3.03 (>= 3.0, left untouched) and gray(149) ≈ 2.99 (< 3.0, recolored).
  // Pins both the threshold value and the >= direction against accidental drift.
  expect(contrastRatio([255, 255, 255], [148, 148, 148])).toBeGreaterThan(3.0);
  expect(contrastRatio([255, 255, 255], [149, 149, 149])).toBeLessThan(3.0);
});

test("contrastRatio is symmetric and bounded at 21 for black/white", () => {
  expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 0);
  expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
});

test("pickReadableTextColor: black on light fills, white on dark fills", () => {
  expect(pickReadableTextColor([224, 255, 255])).toBe("rgb(0, 0, 0)");
  expect(pickReadableTextColor([255, 255, 255])).toBe("rgb(0, 0, 0)");
  expect(pickReadableTextColor([31, 32, 32])).toBe("rgb(255, 255, 255)");
});
