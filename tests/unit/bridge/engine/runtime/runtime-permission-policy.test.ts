import { expect, test } from "bun:test";
import { parseXacpxPermissionPolicy } from "../../../../../src/bridge/engine/runtime/runtime-permission-policy";

test("parses valid policy", () => {
  const p = parseXacpxPermissionPolicy({ autoApprove: ["read"], autoDeny: ["write"], escalate: ["danger"], defaultAction: "approve" });
  expect(p.autoApprove).toEqual(["read"]);
  expect(p.autoDeny).toEqual(["write"]);
  expect(p.escalate).toEqual(["danger"]);
  expect(p.defaultAction).toBe("approve");
});

test("empty object is valid", () => {
  expect(parseXacpxPermissionPolicy({})).toEqual({});
  expect(parseXacpxPermissionPolicy(undefined)).toEqual({});
});

test("null fails closed", () => {
  expect(() => parseXacpxPermissionPolicy(null)).toThrow(/permission policy must be a JSON object/);
});

test("inline JSON string is parsed", () => {
  const p = parseXacpxPermissionPolicy(JSON.stringify({ autoApprove: ["a"], defaultAction: "deny" }));
  expect(p.autoApprove).toEqual(["a"]);
  expect(p.defaultAction).toBe("deny");
});

test("invalid JSON string placeholder fails closed", () => {
  expect(() => parseXacpxPermissionPolicy("autoApprove:read-files")).toThrow(/invalid permission policy file/);
});

test("unknown field fails closed", () => {
  expect(() => parseXacpxPermissionPolicy({ unknown: [] })).toThrow(/unknown permission policy field/);
});

test("invalid defaultAction fails closed", () => {
  expect(() => parseXacpxPermissionPolicy({ defaultAction: "invalid" })).toThrow(/invalid defaultAction/);
});

test("non-string array element fails", () => {
  expect(() => parseXacpxPermissionPolicy({ autoApprove: ["", "ok"] })).toThrow(/autoApprove must be string\[\]/);
  expect(() => parseXacpxPermissionPolicy({ autoApprove: [123 as unknown as string] })).toThrow();
});

test("invalid JSON object with wrong type fails", () => {
  expect(() => parseXacpxPermissionPolicy(123 as unknown as object)).toThrow(/permission policy must be a JSON object/);
});
