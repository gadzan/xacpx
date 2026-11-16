import { expect, test } from "bun:test";

import {
  canonicalFileTime,
  cimIdentityMatchesHandle,
  creationOrderIsValid,
  dmtfDateTimeToFileTime,
  exactHandleIdentityMatches,
  parseCanonicalFileTime,
  processBirthMatches,
} from "../../../src/process/windows-process-identity";

test("accepts only canonical uint64 FILETIME decimal strings", () => {
  expect(parseCanonicalFileTime("0")).toBe(0n);
  expect(parseCanonicalFileTime("18446744073709551615")).toBe(18_446_744_073_709_551_615n);
  for (const malformed of [null, 1, "", "01", "+1", "-1", "1.0", "18446744073709551616"]) {
    expect(parseCanonicalFileTime(malformed)).toBeNull();
  }
  expect(() => canonicalFileTime(-1n)).toThrow();
});

test("converts DMTF timestamps and applies the encoded UTC offset", () => {
  const utc = dmtfDateTimeToFileTime("20260805010203.123456+000");
  const east = dmtfDateTimeToFileTime("20260805090203.123456+480");
  expect(utc).toBe(east);
  expect(parseCanonicalFileTime(utc)).not.toBeNull();
  expect(dmtfDateTimeToFileTime("20260230010203.000000+000")).toBeNull();
  expect(dmtfDateTimeToFileTime("20260805010203.******+000")).toBeNull();
});

test("uses exact comparison for handle identities and nine-tick tolerance only for CIM", () => {
  expect(exactHandleIdentityMatches("100", "100")).toBe(true);
  expect(exactHandleIdentityMatches("100", "101")).toBe(false);
  expect(cimIdentityMatchesHandle("100", "109")).toBe(true);
  expect(cimIdentityMatchesHandle("100", "110")).toBe(false);
  expect(cimIdentityMatchesHandle("01", "1")).toBe(false);
});

test("recorded-birth comparison is exact for handle reads and tolerant only for CIM reads", () => {
  const recorded = "134384907489251763";
  // Handle provenance: a single tick is a different process.
  expect(processBirthMatches(recorded, recorded)).toBe(true);
  expect(processBirthMatches(recorded, "134384907489251764")).toBe(false);
  expect(processBirthMatches(recorded, "134392843210453732", "handle")).toBe(false);
  // CIM provenance: Win32_Process quantizes the low FILETIME digits, so the
  // same live process can differ by up to 9 ticks and must still read "alive".
  expect(processBirthMatches(recorded, "134384907489251772", "cim")).toBe(true);
  expect(processBirthMatches(recorded, "134392843210453732", "cim")).toBe(false);
  // Unparseable either side is never a match (fail closed).
  expect(processBirthMatches(recorded, "not-a-birth", "cim")).toBe(false);
});

test("creation order is a direct ordering check without equality tolerance", () => {
  expect(creationOrderIsValid("100", "100")).toBe(true);
  expect(creationOrderIsValid("100", "101")).toBe(true);
  expect(creationOrderIsValid("100", "99")).toBe(false);
});
