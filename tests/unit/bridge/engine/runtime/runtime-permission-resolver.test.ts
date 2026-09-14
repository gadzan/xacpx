import { expect, test } from "bun:test";
import type { RuntimePermissionConfig, RuntimePermissionRequest } from "../../../../../src/bridge/engine/runtime/runtime-permission-resolver";
import { RuntimePermissionResolver } from "../../../../../src/bridge/engine/runtime/runtime-permission-resolver";

function req(text: string, kind?: string): RuntimePermissionRequest {
  // Match upstream token semantics: title (and kind) are the primary signals;
  // `name` alone is not a token — tests must set title/rawInput as production does.
  return {
    sessionId: "s",
    raw: { toolCall: { title: text, kind, rawInput: { name: text } } } as unknown as Record<string, unknown>,
    inferredKind: kind,
  } as unknown as RuntimePermissionRequest;
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
  const cfg = null as unknown as RuntimePermissionConfig;
  expect(r.safeResolve(cfg, req("x"))).toEqual({ outcome: "reject_once" });
});

test("malformed raw with approve-all still rejects", () => {
  const r = new RuntimePermissionResolver();
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const };
  const circular: Record<string, unknown> = {};
  (circular as Record<string, unknown>).self = circular;
  const reqCircular = { sessionId: "s", raw: { toolCall: { name: "x", input: circular } } } as unknown as RuntimePermissionRequest;
  expect(r.safeResolve(cfg, reqCircular)).toEqual({ outcome: "reject_once" });
  const reqBigInt = { sessionId: "s", raw: { toolCall: { name: "x", input: { v: BigInt(1) } } } } as unknown as RuntimePermissionRequest;
  expect(r.safeResolve(cfg, reqBigInt)).toEqual({ outcome: "reject_once" });
});

test("readToolInputFromReq prefers legacy tool input, then ACP subject/description", async () => {
  const { readToolInputFromReq } = await import("../../../../../src/bridge/engine/runtime/runtime-permission-resolver.js");
  const wrap = (raw: unknown): RuntimePermissionRequest =>
    ({ sessionId: "s", raw }) as unknown as RuntimePermissionRequest;
  // Legacy shapes keep identical results.
  expect(readToolInputFromReq(wrap({ toolCall: { rawInput: { command: "ls" } } }))).toEqual({ command: "ls" });
  expect(readToolInputFromReq(wrap({ toolCall: { input: { path: "/a" } } }))).toEqual({ path: "/a" });
  // Text content blocks are what survives acpx SDK validation (unknown
  // `input` keys are stripped at the boundary).
  expect(
    readToolInputFromReq(
      wrap({ toolCall: { toolCallId: "t1", title: "edit file", content: [{ type: "text", text: "npm run test" }] } }),
    ),
  ).toBe("npm run test");
  // Real ACP shape: structured command subject wins over the envelope.
  expect(
    readToolInputFromReq(
      wrap({
        sessionId: "mock-sess",
        title: "Run command",
        subject: { type: "command", command: "npm run test", cwd: "/repo" },
        options: [{ optionId: "allow_once", kind: "allow_once" }],
      }),
    ),
  ).toEqual({ type: "command", command: "npm run test", cwd: "/repo" });
  // Description is the fallback when no structured input exists.
  expect(readToolInputFromReq(wrap({ title: "t", description: "needs network" }))).toBe("needs network");
  // Nothing usable: undefined (caller falls back to title/kind).
  expect(readToolInputFromReq(wrap({ sessionId: "s", title: "t", options: [] }))).toBeUndefined();
});
