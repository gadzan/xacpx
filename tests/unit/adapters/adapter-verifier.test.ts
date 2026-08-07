import { expect, test } from "bun:test";

import { verifyAcpInitialize } from "../../../src/adapters/adapter-verifier";

const SUCCESS_SCRIPT = String.raw`
process.stdin.setEncoding("utf8");
let text = "";
process.stdin.on("data", chunk => {
  text += chunk;
  const line = text.split("\n")[0];
  if (!line) return;
  const request = JSON.parse(line);
  setTimeout(() => {
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{}}}) + "\n");
  }, 30);
});
process.stdin.on("end", () => process.exit(0));
`;

test("accepts an adapter only after a successful ACP initialize response", async () => {
  await expect(verifyAcpInitialize(process.execPath, ["-e", SUCCESS_SCRIPT], { timeoutMs: 2_000 }))
    .resolves.toBeUndefined();
});

test("reports an ACP initialize error without persisting a bad adapter", async () => {
  const script = String.raw`
  process.stdin.resume();
  process.stdin.once("data", () => process.stdout.write(JSON.stringify({
    jsonrpc:"2.0",id:0,error:{code:-32603,message:"adapter boot failed"}
  }) + "\n"));
  `;
  await expect(verifyAcpInitialize(process.execPath, ["-e", script], { timeoutMs: 2_000 }))
    .rejects.toThrow("adapter boot failed");
});

test("times out and terminates an adapter that never initializes", async () => {
  const script = "process.stdin.resume(); setInterval(() => {}, 1000)";
  const startedAt = Date.now();
  await expect(verifyAcpInitialize(process.execPath, ["-e", script], { timeoutMs: 30 }))
    .rejects.toThrow("timed out after 30ms");
  // On Windows the teardown really probes and kills the tree through the
  // PowerShell worker (CIM enumeration included), which takes seconds; the
  // budget only needs to prove the 30ms timeout fired instead of hanging.
  expect(Date.now() - startedAt).toBeLessThan(process.platform === "win32" ? 15_000 : 2_000);
}, 20_000);

test("npm E404 failures point users to the adapter registry setting", async () => {
  await expect(verifyAcpInitialize(
    process.execPath,
    ["-e", "console.error('npm ERR! code E404'); process.exit(1)"],
    { adapterRegistry: "https://npm.corp.example/" },
  )).rejects.toThrow("xacpx adapter registry set https://registry.npmjs.org");
});
