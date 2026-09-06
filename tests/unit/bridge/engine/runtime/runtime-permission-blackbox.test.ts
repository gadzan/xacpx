import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { RuntimePermissionResolver, type RuntimePermissionConfig } from "../../../../../src/bridge/engine/runtime/runtime-permission-resolver";
import { parseXacpxPermissionPolicy } from "../../../../../src/bridge/engine/runtime/runtime-permission-policy";

/**
 * True black-box differential test (G5 / PR9-B):
 * Spawns an isolated node child running real public `createAcpRuntime` from `acpx/runtime`
 * with the exact same permission configuration and a mock ACP agent that issues a real
 * `session/request_permission` RPC with the tool parameters.
 * Asserts hard parity: `expect(resolver.resolve(...)).toBe(oracleDecision)`.
 */
async function acpxOracleDecision(
  config: RuntimePermissionConfig,
  toolTitle: string,
  toolKind?: string,
  rawInput?: unknown,
): Promise<"allow_once" | "reject_once"> {
  const dir = await mkdtemp(join(tmpdir(), "acpx-oracle-"));
  const script = join(dir, "oracle.mjs");
  const resultFile = join(dir, "result.json");
  const agentFile = join(dir, "agent.mjs");

  await writeFile(
    agentFile,
    `
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
      toolCall: { toolCallId: "t1", title: ${JSON.stringify(toolTitle)}, kind: ${JSON.stringify(toolKind ?? "other")} },
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
`,
  );

  await writeFile(
    script,
    `
import { createAcpRuntime, createRuntimeStore, createAgentRegistry } from "acpx/runtime";
const policy = ${JSON.stringify(config.permissionPolicy ?? null)};
const mode = ${JSON.stringify(config.permissionMode)};
const nonInt = ${JSON.stringify(config.nonInteractivePermissions)};

const rt = createAcpRuntime({
  cwd: ${JSON.stringify(dir)},
  sessionStore: createRuntimeStore({ stateDir: ${JSON.stringify(dir)} }),
  agentRegistry: createAgentRegistry({ overrides: { mock: ["node", ${JSON.stringify(agentFile)}] } }),
  permissionMode: mode,
  nonInteractivePermissions: nonInt,
  ...(policy ? { permissionPolicy: policy } : {}),
});

const handle = await rt.ensureSession({ sessionKey: "k1", agent: "mock", mode: "persistent", cwd: ${JSON.stringify(dir)} });
const turn = rt.startTurn({ handle, text: "test", mode: "prompt", requestId: "r1" });
turn.events[Symbol.asyncIterator]().next().catch(() => {});
await turn.result.catch(() => {});
`,
  );

  return new Promise<"allow_once" | "reject_once">((resolve, reject) => {
    const cp = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    cp.stderr.on("data", (d) => (err += String(d)));
    cp.on("close", async () => {
      try {
        const data = await Bun.file(resultFile).text().catch(() => "");
        const parsed = JSON.parse(data || "{}") as { decision?: string };
        if (parsed.decision === "allow_once" || parsed.decision === "reject_once") {
          resolve(parsed.decision);
        } else {
          reject(new Error(`oracle produced no decision: ${err}`));
        }
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
    setTimeout(async () => {
      cp.kill("SIGTERM");
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      reject(new Error("acpx oracle timed out"));
    }, 10_000).unref?.();
  });
}

function reqFor(title: string, kind?: string, rawInput?: unknown): import("../../../../../src/bridge/engine/runtime/runtime-permission-resolver").RuntimePermissionRequest {
  return {
    sessionId: "s",
    raw: { toolCall: { toolCallId: "t1", title, kind, name: title.split(":")[0], input: rawInput, rawInput } },
    inferredKind: kind,
  } as unknown as import("../../../../../src/bridge/engine/runtime/runtime-permission-resolver").RuntimePermissionRequest;
}

const resolver = new RuntimePermissionResolver();

async function expectBlackBoxParity(
  cfg: RuntimePermissionConfig,
  title: string,
  kind?: string,
  rawInput?: unknown,
) {
  const our = resolver.safeResolve(cfg, reqFor(title, kind, rawInput));
  const oracle = await acpxOracleDecision(cfg, title, kind, rawInput);
  // Hard differential assertion: our resolver output MUST match the acpx public runtime decision
  expect(our.outcome).toBe(oracle);
}

test("black-box: approve-all allows", async () => {
  const cfg: RuntimePermissionConfig = { generation: 0, permissionMode: "approve-all", nonInteractivePermissions: "deny", permissionPolicy: {} };
  await expectBlackBoxParity(cfg, "read file", "read");
}, 15_000);

test("black-box: deny-all rejects", async () => {
  const cfg: RuntimePermissionConfig = { generation: 0, permissionMode: "deny-all", nonInteractivePermissions: "deny", permissionPolicy: {} };
  await expectBlackBoxParity(cfg, "read file", "read");
}, 15_000);

test("black-box: approve-reads read/search allow, write/execute reject", async () => {
  const cfg: RuntimePermissionConfig = { generation: 0, permissionMode: "approve-reads", nonInteractivePermissions: "deny", permissionPolicy: {} };
  await expectBlackBoxParity(cfg, "read file", "read");
  await expectBlackBoxParity(cfg, "search code", "search");
  await expectBlackBoxParity(cfg, "write file", "edit");
  await expectBlackBoxParity(cfg, "exec command", "execute");
}, 20_000);

test("black-box: autoDeny beats autoApprove", async () => {
  const policy = parseXacpxPermissionPolicy({ autoDeny: ["dangerous"], autoApprove: ["dangerous"] });
  const cfg: RuntimePermissionConfig = { generation: 0, permissionMode: "approve-all", nonInteractivePermissions: "deny", permissionPolicy: policy };
  await expectBlackBoxParity(cfg, "dangerous tool", "execute");
}, 15_000);

test("black-box: inline policy vs file parity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "policy-file-"));
  const pfile = join(dir, "policy.json");
  await writeFile(pfile, JSON.stringify({ autoDeny: ["delete_file"], defaultAction: "approve" }));
  const policyFile = parseXacpxPermissionPolicy(pfile);
  const cfg: RuntimePermissionConfig = { generation: 0, permissionMode: "deny-all", nonInteractivePermissions: "deny", permissionPolicy: policyFile };
  await expectBlackBoxParity(cfg, "delete_file", "edit");
  await expectBlackBoxParity(cfg, "read_file", "read");
  await rm(dir, { recursive: true, force: true });
}, 15_000);

test("black-box: malformed policy fail closed", async () => {
  expect(() => parseXacpxPermissionPolicy("{invalid json")).toThrow(/invalid permission policy/);
  expect(() => parseXacpxPermissionPolicy({ unknownKey: true })).toThrow(/unknown permission policy/);
});
