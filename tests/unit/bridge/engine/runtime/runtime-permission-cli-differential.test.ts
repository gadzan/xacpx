import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  RuntimePermissionResolver,
  type RuntimePermissionConfig,
  type RuntimePermissionRequest,
} from "../../../../../src/bridge/engine/runtime/runtime-permission-resolver";
import {
  parseXacpxPermissionPolicy,
  isEligibleForRuntime,
} from "../../../../../src/bridge/engine/runtime/runtime-permission-policy";

/**
 * P2 / Activation Gate: Pinned acpx CLI black-box differential test.
 *
 * Spawns the real pinned acpx 0.13.1 CLI binary against an isolated mock ACP agent,
 * passing identical permission CLI flags and policy configurations.
 *
 * Compares that:
 * 1. RuntimePermissionResolver's decisions match acpx CLI's decisions for every case.
 * 2. isEligibleForRuntime correctly reflects runtime execution eligibility.
 *
 * Required test scenarios covered:
 * 1. autoDeny > autoApprove precedence
 * 2. rawInput name / tool / toolName property extraction and case-insensitivity
 * 3. approve-reads kind inference (read / search allow, write / execute reject)
 * 4. defaultAction (approve / deny / escalate)
 * 5. escalate (non-interactive rejection vs interactive escalation requirement)
 * 6. inline vs file policy parity
 */

function resolveAcpxCli(): { command: string; args: string[] } | null {
  const localDist = resolve(import.meta.dir, "../../../../../node_modules/acpx/dist/cli.js");
  if (existsSync(localDist)) {
    return { command: process.execPath, args: [localDist] };
  }
  const localBin = resolve(import.meta.dir, "../../../../../node_modules/.bin/acpx");
  if (existsSync(localBin)) {
    return { command: localBin, args: [] };
  }
  try {
    const res = spawnSync("npx", ["--no-install", "acpx@0.13.1", "--version"], { stdio: "ignore", timeout: 5000 });
    if (res.status === 0) {
      return { command: "npx", args: ["acpx@0.13.1"] };
    }
  } catch {}
  return null;
}

const cliTarget = resolveAcpxCli();
const testCli = cliTarget ? test : test.skip;

const resolver = new RuntimePermissionResolver();

function reqFor(title: string, kind?: string, rawInput?: unknown): RuntimePermissionRequest {
  return {
    sessionId: "s",
    raw: {
      toolCall: {
        toolCallId: "t1",
        title,
        kind,
        name: title.split(/[:\s]/, 1)[0],
        input: rawInput,
        rawInput,
      },
      rawInput,
    },
    inferredKind: kind,
  };
}

async function runCliPermissionDecision(
  config: RuntimePermissionConfig,
  toolTitle: string,
  toolKind?: string,
  rawInput?: unknown,
  policyFileContent?: string,
): Promise<"allow_once" | "reject_once"> {
  if (!cliTarget) {
    throw new Error("acpx CLI binary not available");
  }

  const dir = await mkdtemp(join(tmpdir(), "acpx-cli-diff-"));
  const agentFile = join(dir, "agent.mjs");
  const resultFile = join(dir, "result.json");

  const agentCode = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
function requestPerm(id, sid, req) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: sid, ...req } }) + "\\n"); }
let turnId = null;
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    respond(m.id, { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true, promptCapabilities: {}, sessionCapabilities: { new:{}, load:{}, resume:{}, close:{}, list:{}, cancel:{} } } });
  } else if (m.method === "session/new" || m.method === "session/load" || m.method === "session/resume") {
    respond(m.id, { sessionId: m.params?.sessionId ?? "s1" });
  } else if (m.method === "session/prompt") {
    turnId = m.id;
    const sid = m.params?.sessionId ?? "s1";
    requestPerm(99, sid, {
      toolCall: {
        toolCallId: "t1",
        title: ${JSON.stringify(toolTitle)},
        kind: ${JSON.stringify(toolKind ?? "other")},
        rawInput: ${JSON.stringify(rawInput ?? {})},
      },
      options: [
        { optionId: "allow_once", name: "allow_once", kind: "allow_once" },
        { optionId: "reject_once", name: "reject_once", kind: "reject_once" }
      ],
      rawInput: ${JSON.stringify(rawInput ?? {})},
    });
  } else if (m.id === 99) {
    const outcome = m.result?.outcome?.optionId ?? (m.result?.outcome?.outcome === "cancelled" ? "reject_once" : "reject_once");
    const dec = (outcome === "allow_once" || outcome === "allow_always") ? "allow_once" : "reject_once";
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ decision: dec }));
    respond(turnId, { sessionId: "s1" });
    process.exit(0);
  } else {
    respond(m.id, {});
  }
});
`;
  await writeFile(agentFile, agentCode);

  let policyArg: string | undefined;
  if (policyFileContent !== undefined) {
    const pfile = join(dir, "policy.json");
    await writeFile(pfile, policyFileContent);
    policyArg = pfile;
  } else if (config.permissionPolicy) {
    policyArg = JSON.stringify(config.permissionPolicy);
  }

  const args = [
    ...cliTarget.args,
    "--agent", `${process.execPath} ${agentFile}`,
    "--cwd", dir,
    "--non-interactive-permissions", config.nonInteractivePermissions ?? "deny",
  ];
  if (config.permissionMode === "approve-all") args.push("--approve-all");
  else if (config.permissionMode === "approve-reads") args.push("--approve-reads");
  else if (config.permissionMode === "deny-all") args.push("--deny-all");

  if (policyArg) {
    args.push("--permission-policy", policyArg);
  }

  args.push("exec", "test-prompt");

  return new Promise<"allow_once" | "reject_once">((resolveP, reject) => {
    const cp = spawn(cliTarget.command, args, {
      env: { ...process.env, HOME: dir },
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(15_000),
    });
    let err = "";
    cp.stderr.on("data", (d) => (err += String(d)));
    cp.on("close", async (code) => {
      try {
        if (existsSync(resultFile)) {
          const parsed = JSON.parse(readFileSync(resultFile, "utf8")) as { decision?: "allow_once" | "reject_once" };
          if (parsed.decision === "allow_once" || parsed.decision === "reject_once") {
            resolveP(parsed.decision);
            return;
          }
        }
        reject(new Error(`acpx CLI exited with code ${code} without recording decision: ${err}`));
      } catch (e) {
        reject(e);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
    cp.on("error", async (e) => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      reject(e);
    });
  });
}

async function expectCliParity(
  config: RuntimePermissionConfig,
  toolTitle: string,
  toolKind?: string,
  rawInput?: unknown,
  policyFileContent?: string,
) {
  const ourDecision = resolver.safeResolve(config, reqFor(toolTitle, toolKind, rawInput)).outcome;
  const cliDecision = await runCliPermissionDecision(config, toolTitle, toolKind, rawInput, policyFileContent);
  expect(ourDecision).toBe(cliDecision);
}

// --------------------------------------------------------------------------
// 1. autoDeny > autoApprove precedence
// --------------------------------------------------------------------------
testCli("CLI differential 1: autoDeny takes strict precedence over autoApprove", async () => {
  const policy = parseXacpxPermissionPolicy({
    autoDeny: ["dangerous_tool"],
    autoApprove: ["dangerous_tool"],
  });
  const config: RuntimePermissionConfig = {
    generation: 0,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    permissionPolicy: policy,
  };

  await expectCliParity(config, "dangerous_tool", "execute");

  // Wildcard deny also beats specific approve
  const wildcardDenyPolicy = parseXacpxPermissionPolicy({
    autoDeny: ["*"],
    autoApprove: ["read_file"],
  });
  const wildcardConfig: RuntimePermissionConfig = {
    generation: 0,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    permissionPolicy: wildcardDenyPolicy,
  };

  await expectCliParity(wildcardConfig, "read_file", "read");
}, 30_000);

// --------------------------------------------------------------------------
// 2. rawInput name / tool / toolName property extraction and matching
// --------------------------------------------------------------------------
testCli("CLI differential 2: rawInput name, tool, and toolName tokens match case-insensitively", async () => {
  // 2a: rawInput.name matched in autoDeny
  const policyName = parseXacpxPermissionPolicy({ autoDeny: ["special_cmd"] });
  const cfgName: RuntimePermissionConfig = {
    generation: 0,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    permissionPolicy: policyName,
  };
  await expectCliParity(cfgName, "generic title", "execute", { name: "special_cmd" });

  // 2b: rawInput.tool matched in autoApprove
  const policyTool = parseXacpxPermissionPolicy({ autoApprove: ["custom_helper"] });
  const cfgTool: RuntimePermissionConfig = {
    generation: 0,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    permissionPolicy: policyTool,
  };
  await expectCliParity(cfgTool, "generic title", "execute", { tool: "custom_helper" });

  // 2c: rawInput.toolName matched case-insensitively
  const policyToolName = parseXacpxPermissionPolicy({ autoApprove: ["case_test_tool"] });
  const cfgToolName: RuntimePermissionConfig = {
    generation: 0,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    permissionPolicy: policyToolName,
  };
  await expectCliParity(cfgToolName, "generic title", "execute", { toolName: "CASE_TEST_TOOL" });
}, 30_000);

// --------------------------------------------------------------------------
// 3. approve-reads kind inference
// --------------------------------------------------------------------------
testCli("CLI differential 3: approve-reads mode allows read and search kinds, rejects write and execute", async () => {
  const cfgReads: RuntimePermissionConfig = {
    generation: 0,
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
  };

  await expectCliParity(cfgReads, "read file", "read");
  await expectCliParity(cfgReads, "search code", "search");
  await expectCliParity(cfgReads, "write file", "edit");
  await expectCliParity(cfgReads, "run bash", "execute");
}, 30_000);

// --------------------------------------------------------------------------
// 4. defaultAction
// --------------------------------------------------------------------------
testCli("CLI differential 4: defaultAction approve/deny overrides fallback mode for unmatched requests", async () => {
  // defaultAction: approve allows under deny-all
  const policyApprove = parseXacpxPermissionPolicy({ defaultAction: "approve" });
  const cfgApprove: RuntimePermissionConfig = {
    generation: 0,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    permissionPolicy: policyApprove,
  };
  await expectCliParity(cfgApprove, "unmatched tool", "other");

  // defaultAction: deny rejects under approve-all
  const policyDeny = parseXacpxPermissionPolicy({ defaultAction: "deny" });
  const cfgDeny: RuntimePermissionConfig = {
    generation: 0,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    permissionPolicy: policyDeny,
  };
  await expectCliParity(cfgDeny, "unmatched tool", "other");
}, 30_000);

// --------------------------------------------------------------------------
// 5. escalate & isEligibleForRuntime gate
// --------------------------------------------------------------------------
testCli("CLI differential 5: escalate rejects in non-interactive CLI and gates isEligibleForRuntime", async () => {
  const policyEscalate = parseXacpxPermissionPolicy({
    escalate: ["critical_op"],
    defaultAction: "escalate",
  });
  const cfgEscalate: RuntimePermissionConfig = {
    generation: 0,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    permissionPolicy: policyEscalate,
  };

  // In non-interactive mode, CLI rejects escalation
  await expectCliParity(cfgEscalate, "critical_op", "execute");

  // Verify isEligibleForRuntime gates policy eligibility based on interactive capability
  expect(isEligibleForRuntime(policyEscalate, "deny", false)).toBe(false);
  expect(isEligibleForRuntime(policyEscalate, "deny", true)).toBe(true);
  expect(isEligibleForRuntime(policyEscalate, "fail", true)).toBe(false);

  // Runtime resolver with interactiveAvailable = true signals needs_interaction
  const evalResult = resolver.evaluate(
    cfgEscalate,
    reqFor("critical_op", "execute"),
    { interactiveAvailable: true },
  );
  expect(evalResult.outcome).toBe("needs_interaction");
}, 30_000);

// --------------------------------------------------------------------------
// 6. inline vs file policy parity
// --------------------------------------------------------------------------
testCli("CLI differential 6: inline policy and file policy produce identical CLI and resolver outcomes", async () => {
  const policyObject = {
    autoApprove: ["allowed_file_op"],
    autoDeny: ["forbidden_file_op"],
    defaultAction: "deny" as const,
  };
  const fileContent = JSON.stringify(policyObject);
  const parsedPolicy = parseXacpxPermissionPolicy(policyObject);

  const cfg: RuntimePermissionConfig = {
    generation: 0,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    permissionPolicy: parsedPolicy,
  };

  // Matched autoApprove rule
  await expectCliParity(cfg, "allowed_file_op", "other", undefined, fileContent);

  // Matched autoDeny rule
  await expectCliParity(cfg, "forbidden_file_op", "other", undefined, fileContent);

  // Fallback defaultAction: deny
  await expectCliParity(cfg, "other_file_op", "other", undefined, fileContent);
}, 30_000);
