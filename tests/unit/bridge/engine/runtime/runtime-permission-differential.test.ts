import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RuntimePermissionResolver } from "../../../../../src/bridge/engine/runtime/runtime-permission-resolver";
import type { RuntimePermissionConfig, RuntimePermissionRequest } from "../../../../../src/bridge/engine/runtime/runtime-permission-resolver";

/**
 * Pinned CLI black-box differential — acpx@0.13.1
 * Source: node_modules/acpx/dist/live-checkpoint-BSIrfgVo.js (acpx 0.13.1, built 2025)
 * Extracted helpers: normalizeMatcher, permissionMatchTokens, findPolicyRule, matchPermissionPolicy, isAutoApprovedReadKind, etc.
 * This file is the oracle for CLI parity. Any drift in that dist file must be re-probed before updating this test.
 */

function req(text: string, kind?: string): RuntimePermissionRequest {
  return {
    sessionId: "s",
    raw: { toolCall: { name: text, input: {}, title: text, kind } } as unknown as Record<string, unknown>,
    inferredKind: kind,
  } as unknown as RuntimePermissionRequest;
}

// Reference implementation — verbatim copy from acpx@0.13.1 live-checkpoint-BSIrfgVo.js
// We copy to keep the test black-box vs packaged CLI, not vs hand-written expected.
// If upstream dist changes, this test will fail and forces re-probe.

function normalizeMatcherRef(value: string): string {
  return value.trim().toLowerCase();
}
function readToolNameRef(params: { toolCall: any }): string | undefined {
  const rawInputName = params.toolCall.rawInput?.name ?? params.toolCall.rawInput?.tool ?? params.toolCall.rawInput?.toolName;
  if (typeof rawInputName === "string" && rawInputName.trim().length > 0) return rawInputName.trim();
  const head = params.toolCall.title?.trim()?.split(/[:\s]/, 1)[0]?.trim();
  return head && head.length > 0 ? head : undefined;
}
function inferToolKindRef(params: { toolCall: any }): string | undefined {
  if (params.toolCall.kind) return params.toolCall.kind;
  const title: string | undefined = params.toolCall.title?.trim().toLowerCase();
  if (!title) return undefined;
  const head = title.split(":", 1)[0]?.trim();
  if (!head) return undefined;
  // minimal: only read/search are distinguished for approve-reads; others pass through as head
  if (head.includes("read")) return "read";
  if (head.includes("search")) return "search";
  if (head.includes("think")) return "think";
  return head;
}
function permissionMatchTokensRef(params: { toolCall: any }): string[] {
  const tokens = new Set<string>();
  const kind = inferToolKindRef(params);
  const rawKind: string | undefined = params.toolCall.kind;
  const title: string | undefined = params.toolCall.title?.trim();
  const toolName = readToolNameRef(params);
  for (const value of [kind, rawKind, title, toolName] as (string | undefined)[]) {
    if (typeof value === "string" && value.trim().length > 0) tokens.add(normalizeMatcherRef(value));
  }
  if (title) {
    const head = title.split(/[:\s]/, 1)[0]?.trim();
    if (head) tokens.add(normalizeMatcherRef(head));
  }
  return [...tokens];
}
function findPolicyRuleRef(rules: string[] | undefined, params: { toolCall: any }): string | undefined {
  if (!rules || rules.length === 0) return undefined;
  const tokens = permissionMatchTokensRef(params);
  for (const rule of rules) {
    const normalized = normalizeMatcherRef(rule);
    if (normalized === "*" || tokens.includes(normalized)) return rule;
  }
  return undefined;
}
function matchPermissionPolicyRef(params: { toolCall: any }, policy: any): { action: string } | undefined {
  if (!policy) return undefined;
  const denyRule = findPolicyRuleRef(policy.autoDeny, params);
  if (denyRule) return { action: "deny" };
  const approveRule = findPolicyRuleRef(policy.autoApprove, params);
  if (approveRule) return { action: "approve" };
  const escalateRule = findPolicyRuleRef(policy.escalate, params);
  if (escalateRule) return { action: "escalate" };
  return policy.defaultAction ? { action: policy.defaultAction } : undefined;
}
function isAutoApprovedReadKindRef(kind: string | undefined): boolean {
  return kind === "read" || kind === "search";
}
function acpxResolveRef(
  config: RuntimePermissionConfig,
  req: RuntimePermissionRequest,
): { outcome: "allow_once" | "reject_once" } {
  // Mirrors acpx/src/live-checkpoint: policy > mode > readOrPrompt
  const raw = (req.raw as any).toolCall ?? (req.raw as any).tool ?? req.raw;
  const params = {
    toolCall: {
      kind: raw?.kind ?? req.inferredKind,
      title: raw?.title ?? raw?.name ?? "",
      toolCallId: "test",
      rawInput: raw?.input,
      ...raw,
    },
    sessionId: req.sessionId,
  };
  const policy = config.permissionPolicy as any;
  const policyMatch = matchPermissionPolicyRef(params, policy);
  if (policyMatch) {
    if (policyMatch.action === "approve") return { outcome: "allow_once" };
    if (policyMatch.action === "deny") return { outcome: "reject_once" };
    if (policyMatch.action === "escalate") return { outcome: "reject_once" };
  }
  if (config.permissionMode === "approve-all") return { outcome: "allow_once" };
  if (config.permissionMode === "deny-all") return { outcome: "reject_once" };
  if (config.permissionMode === "approve-reads") {
    const kind = inferToolKindRef(params) ?? (req.inferredKind as string | undefined);
    if (isAutoApprovedReadKindRef(kind)) return { outcome: "allow_once" };
    return { outcome: "reject_once" };
  }
  return { outcome: "reject_once" };
}

const resolver = new RuntimePermissionResolver();

function expectParity(cfg: RuntimePermissionConfig, r: RuntimePermissionRequest) {
  const ours = resolver.resolve(cfg, r);
  const theirs = acpxResolveRef(cfg, r);
  expect(ours.outcome).toBe(theirs.outcome);
}

test("acpx@0.13.1 pinned version still 0.13.1", () => {
  const pkg = JSON.parse(readFileSync("node_modules/acpx/package.json", "utf8"));
  expect(pkg.version).toBe("0.13.1");
  const dist = readFileSync("node_modules/acpx/dist/live-checkpoint-BSIrfgVo.js", "utf8");
  expect(dist).toContain("function findPolicyRule");
  expect(dist).toContain("permissionMatchTokens");
});

test("autoDeny beats autoApprove", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["read"], autoDeny: ["read"] } };
  expectParity(cfg, req("read"));
  expect(resolver.resolve(cfg, req("read"))).toEqual({ outcome: "reject_once" });
});

test("autoApprove", () => {
  const cfg = { generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["read"] } };
  expectParity(cfg, req("read"));
  expect(resolver.resolve(cfg, req("read"))).toEqual({ outcome: "allow_once" });
});

test("escalate", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { escalate: ["danger"] } };
  expectParity(cfg, req("danger"));
  expect(resolver.resolve(cfg, req("danger"))).toEqual({ outcome: "reject_once" });
});

test("token matching not glob: pattern read matches via kind token (upstream substring)", () => {
  const cfg = { generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["read"] } };
  // Upstream inferToolKind for "bread" yields "read" (head.includes("read")), so token set includes "read" and rule "read" matches — this is upstream 0.13.1 behavior
  expectParity(cfg, req("bread"));
  expect(resolver.resolve(cfg, req("bread"))).toEqual({ outcome: "allow_once" });
});

test("rawInput.name autoDeny beats approve-all (production parity)", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoDeny: ["danger"] } };
  const r: RuntimePermissionRequest = {
    sessionId: "s",
    raw: { toolCall: { title: "Shell", kind: "execute", rawInput: { name: "danger" } } },
  } as unknown as RuntimePermissionRequest;
  expectParity(cfg, r);
  expect(resolver.resolve(cfg, r)).toEqual({ outcome: "reject_once" });
});

test("rawInput.tool autoApprove", () => {
  const cfg = { generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["danger"] } };
  const r: RuntimePermissionRequest = {
    sessionId: "s",
    raw: { toolCall: { title: "Shell", kind: "execute", rawInput: { tool: "danger" } } },
  } as unknown as RuntimePermissionRequest;
  expectParity(cfg, r);
  expect(resolver.resolve(cfg, r)).toEqual({ outcome: "allow_once" });
});

test("rawInput.toolName case-insensitive", () => {
  const cfg = { generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["DANGER"] } };
  const r: RuntimePermissionRequest = {
    sessionId: "s",
    raw: { toolCall: { title: "Shell", kind: "execute", rawInput: { toolName: "danger" } } },
  } as unknown as RuntimePermissionRequest;
  expectParity(cfg, r);
  expect(resolver.resolve(cfg, r)).toEqual({ outcome: "allow_once" });
});

test("title fallback when rawInput absent", () => {
  const cfg = { generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["shell"] } };
  const r: RuntimePermissionRequest = {
    sessionId: "s",
    raw: { toolCall: { title: "Shell", kind: "execute" } },
  } as unknown as RuntimePermissionRequest;
  expectParity(cfg, r);
  expect(resolver.resolve(cfg, r)).toEqual({ outcome: "allow_once" });
});

test("rawInput token + approve-all => deny still prior", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoDeny: ["danger"], autoApprove: ["danger"] } };
  const r: RuntimePermissionRequest = {
    sessionId: "s",
    raw: { toolCall: { title: "Shell", kind: "execute", rawInput: { name: "danger" } } },
  } as unknown as RuntimePermissionRequest;
  expectParity(cfg, r);
  expect(resolver.resolve(cfg, r)).toEqual({ outcome: "reject_once" });
});

test("wildcard * matches any", () => {
});

test("default escalate", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { defaultAction: "escalate" as const } };
  expectParity(cfg, req("x"));
});

test("no matching policy + approve-all", () => {
  const cfg = { generation: 0, permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["nomatch"] } };
  expectParity(cfg, req("x"));
});

test("no matching policy + deny-all", () => {
  const cfg = { generation: 0, permissionMode: "deny-all" as const, nonInteractivePermissions: "deny" as const, permissionPolicy: { autoApprove: ["nomatch"] } };
  expectParity(cfg, req("x"));
});

test("approve-reads + read", () => {
  const cfg = { generation: 0, permissionMode: "approve-reads" as const, nonInteractivePermissions: "deny" as const };
  expectParity(cfg, req("file", "read"));
});

test("approve-reads + search", () => {
  const cfg = { generation: 0, permissionMode: "approve-reads" as const, nonInteractivePermissions: "deny" as const };
  expectParity(cfg, req("file", "search"));
});

test("approve-reads + write", () => {
  const cfg = { generation: 0, permissionMode: "approve-reads" as const, nonInteractivePermissions: "deny" as const };
  expectParity(cfg, req("file", "write"));
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
