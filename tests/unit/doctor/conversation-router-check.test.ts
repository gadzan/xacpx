import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { checkConversationRouter } from "../../../src/doctor/checks/conversation-router-check";

async function withConfig(body: unknown, assert: (configPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-router-doctor-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify(body));
    await assert(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("doctor reports a missing router section as off", async () => {
  await withConfig({ transport: {}, agents: {}, workspaces: {} }, async (configPath) => {
    const result = await checkConversationRouter({
      resolveRuntimePaths: () => ({ configPath, statePath: join(configPath, "..", "state.json") }),
    });
    expect(result).toMatchObject({
      id: "conversation-router",
      severity: "pass",
      summary: "automatic collaboration is off",
    });
    expect(result.details).toContain("status: disabled-by-config");
  });
});

test("doctor fails when the enabled router command is missing", async () => {
  await withConfig({
    transport: {},
    agents: {},
    workspaces: {},
    conversations: { router: { enabled: true } },
  }, async (configPath) => {
    const result = await checkConversationRouter({
      resolveRuntimePaths: () => ({ configPath, statePath: join(configPath, "..", "state.json") }),
    });
    expect(result).toMatchObject({ id: "conversation-router", severity: "fail" });
    expect(result.details).toContain("reason: command-missing");
  });
});
