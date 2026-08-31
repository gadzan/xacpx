import { expect, test } from "bun:test";
import { RuntimePermissionResolver } from "../../../../../src/bridge/engine/runtime/runtime-permission-resolver";

/**
 * Pinned CLI black-box differential: same input permission request → current CLI behavior → Runtime resolver behavior must be equivalent.
 * These cases are derived from plan §16 and the acpx 0.13.1 CLI queue permission policy.
 * They are not exhaustive but lock the precedence and fallback semantics.
 */

function req(text: string, kind?: string) {
  return { sessionId: "s", raw: { toolCall: { name: text, input: {} } } as unknown as Record<string, unknown>, inferredKind: kind } as unknown as import("../../../../../src/bridge/engine/runtime/runtime-permission-resolver").RuntimePermissionRequest;
}

const resolver = new RuntimePermissionResolver();

test("autoDeny beats autoApprove", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["read"], autoDeny: ["read"] } };
  expect(resolver.resolve(cfg, req("read"))).toEqual({ outcome: "reject_once" });
});

test("autoApprove", () => {
  const cfg = { generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["read"] } };
  expect(resolver.resolve(cfg, req("read"))).toEqual({ outcome: "allow_once" });
});

test("escalate", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { escalate: ["danger"] } };
  expect(resolver.resolve(cfg, req("danger"))).toEqual({ outcome: "reject_once" });
});

test("default approve", () => {
  const cfg = { generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { defaultAction: "approve" as const } };
  expect(resolver.resolve(cfg, req("x"))).toEqual({ outcome: "allow_once" });
});

test("default deny", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { defaultAction: "deny" as const } };
  expect(resolver.resolve(cfg, req("x"))).toEqual({ outcome: "reject_once" });
});

test("default escalate", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { defaultAction: "escalate" as const } };
  expect(resolver.resolve(cfg, req("x"))).toEqual({ outcome: "reject_once" });
});

test("no matching policy + approve-all", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["nomatch"] } };
  expect(resolver.resolve(cfg, req("x"))).toEqual({ outcome: "allow_once" });
});

test("no matching policy + deny-all", () => {
  const cfg = { generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["nomatch"] } };
  expect(resolver.resolve(cfg, req("x"))).toEqual({ outcome: "reject_once" });
});

test("approve-reads + read", () => {
  const cfg = { generation: 0, permissionMode: "approve-reads" as const, nonInteractivePermissions: "deny" as const };
  expect(resolver.resolve(cfg, req("file", "read"))).toEqual({ outcome: "allow_once" });
});

test("approve-reads + search", () => {
  const cfg = { generation: 0, permissionMode: "approve-reads" as const, nonInteractivePermissions: "deny" as const };
  expect(resolver.resolve(cfg, req("file", "search"))).toEqual({ outcome: "allow_once" });
});

test("approve-reads + write", () => {
  const cfg = { generation: 0, permissionMode: "approve-reads" as const, nonInteractivePermissions: "deny" as const };
  expect(resolver.resolve(cfg, req("file", "write"))).toEqual({ outcome: "reject_once" });
});

test("inline JSON vs file parity (both parse to same)", () => {
  const json = JSON.stringify({ autoApprove: ["a"], defaultAction: "deny" as const });
  const fromInline = (() => {
    const { parseXacpxPermissionPolicy } = require("../../../../../src/bridge/engine/runtime/runtime-permission-policy");
    return parseXacpxPermissionPolicy(json);
  })();
  const fromFile = (() => {
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const dir = mkdtempSync(join(tmpdir(), "perm-diff-"));
    const fp = join(dir, "policy.json");
    writeFileSync(fp, json, "utf8");
    const { parseXacpxPermissionPolicy } = require("../../../../../src/bridge/engine/runtime/runtime-permission-policy");
    const p = parseXacpxPermissionPolicy(fp);
    rmSync(dir, { recursive: true, force: true });
    return p;
  })();
  expect(fromInline).toEqual(fromFile);
});

test("invalid file/inline shape fail closed", () => {
  const { parseXacpxPermissionPolicy } = require("../../../../../src/bridge/engine/runtime/runtime-permission-policy");
  expect(() => parseXacpxPermissionPolicy("not-a-file.json")).toThrow();
  expect(() => parseXacpxPermissionPolicy("{ invalid json")).toThrow();
  expect(() => parseXacpxPermissionPolicy({ unknown: [] })).toThrow();
});
