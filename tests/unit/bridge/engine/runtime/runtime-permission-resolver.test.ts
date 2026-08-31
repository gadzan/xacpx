import { expect, test } from "bun:test";
import { RuntimePermissionResolver } from "../../../../../src/bridge/engine/runtime/runtime-permission-resolver";

function req(text: string, kind?: string) {
  return { sessionId: "s", raw: { toolCall: { name: text, input: {} } } as unknown as Record<string, unknown>, inferredKind: kind } as unknown as import("../../../../../src/bridge/engine/runtime/runtime-permission-resolver").RuntimePermissionRequest;
}

test("autoDeny beats autoApprove", () => {
  const r = new RuntimePermissionResolver();
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["read"], autoDeny: ["read"] } };
  expect(r.resolve(cfg, req("read"))).toEqual({ outcome: "reject_once" });
});

test("autoApprove", () => {
  const r = new RuntimePermissionResolver();
  const cfg = { generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["read"] } };
  expect(r.resolve(cfg, req("read"))).toEqual({ outcome: "allow_once" });
});

test("escalate -> reject", () => {
  const r = new RuntimePermissionResolver();
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { escalate: ["danger"] } };
  expect(r.resolve(cfg, req("danger"))).toEqual({ outcome: "reject_once" });
});

test("default approve/deny/escalate", () => {
  const r = new RuntimePermissionResolver();
  expect(r.resolve({ generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { defaultAction: "approve" } }, req("x"))).toEqual({ outcome: "allow_once" });
  expect(r.resolve({ generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { defaultAction: "deny" } }, req("x"))).toEqual({ outcome: "reject_once" });
  expect(r.resolve({ generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { defaultAction: "escalate" } }, req("x"))).toEqual({ outcome: "reject_once" });
});

test("permissionMode fallback", () => {
  const r = new RuntimePermissionResolver();
  expect(r.resolve({ generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const }, req("x"))).toEqual({ outcome: "allow_once" });
  expect(r.resolve({ generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const }, req("x"))).toEqual({ outcome: "reject_once" });
});

test("approve-reads: read/search approve, other deny", () => {
  const r = new RuntimePermissionResolver();
  const cfg = { generation: 0, permissionMode: "approve-reads" as const, nonInteractivePermissions: "deny" as const };
  expect(r.resolve(cfg, req("file", "read"))).toEqual({ outcome: "allow_once" });
  expect(r.resolve(cfg, req("file", "search"))).toEqual({ outcome: "allow_once" });
  expect(r.resolve(cfg, req("file", "write"))).toEqual({ outcome: "reject_once" });
});

test("abort signal -> reject", () => {
  const r = new RuntimePermissionResolver();
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const };
  const ac = new AbortController();
  ac.abort();
  expect(r.resolve(cfg, req("x"), ac.signal)).toEqual({ outcome: "reject_once" });
});

test("exception -> reject via safeResolve", () => {
  const r = new RuntimePermissionResolver();
  // Force exception by passing malformed config that triggers internal error? Instead test safeResolve directly
  const cfg = null as unknown as import("../../../../../src/bridge/engine/runtime/runtime-permission-resolver").RuntimePermissionConfig;
  expect(r.safeResolve(cfg, req("x"))).toEqual({ outcome: "reject_once" });
});
