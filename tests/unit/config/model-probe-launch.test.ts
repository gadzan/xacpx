import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { createAdapterReleaseId } from "../../../src/adapters/adapter-catalog";
import { deriveAgentAlias } from "../../../src/config/agent-launch";
import {
  authRevisionForEnv,
  launchFingerprint,
  normalizeProbeSettingsPolicy,
  resolveConfiguredAgentLaunch,
  resolveModelProbeLaunch,
  type ModelProbeLaunchContext,
} from "../../../src/config/resolve-agent-command";

const ENV: NodeJS.ProcessEnv = {};

function contextFor(
  driver: string,
  launch: ModelProbeLaunchContext["launch"],
  extra: Partial<ModelProbeLaunchContext> = {},
): { agent: string; context: ModelProbeLaunchContext } {
  return {
    agent: "probe-agent",
    context: { cwd: "/repo", driver, launch, ...extra },
  };
}

test("user argv reuses the overlay launch verbatim", () => {
  const agent = { driver: "custom", argv: ["C:\\Program Files\\agent.exe", "--acp", ""] };
  const spec = resolveConfiguredAgentLaunch(agent);
  const { context } = contextFor("custom", spec);
  const probe = resolveModelProbeLaunch("probe-agent", context, { env: ENV });
  expect(probe.ok).toBe(true);
  if (!probe.ok) return;
  expect(probe.agentCommand).toEqual(spec.agentArgv);
  expect(spec.acpxAgent).toBe(deriveAgentAlias("custom", spec.agentArgv!));
  expect(spec.acpxAgent.startsWith("xacpx-managed-")).toBe(true);
  expect(probe.identity.launchDigest).toBe(launchFingerprint(spec));
});

test("managed codex pin resolves to the same npx argv as a normal launch", () => {
  const spec = resolveConfiguredAgentLaunch({ driver: "codex" });
  const { context } = contextFor("codex", spec);
  const probe = resolveModelProbeLaunch("probe-agent", context, { env: ENV });
  expect(probe.ok).toBe(true);
  if (!probe.ok) return;
  expect(probe.agentCommand).toEqual([
    "npx",
    "-y",
    "--registry=https://registry.npmjs.org",
    "--@agentclientprotocol:registry=https://registry.npmjs.org",
    "@agentclientprotocol/codex-acp@2.2.2",
  ]);
  expect(probe.identity.adapterVersion).toBe("2.2.2");
  expect(probe.identity.adapterRegistryDigest).toBeUndefined();
});

test("managed claude pin honors version and registry overrides in the identity", () => {
  const transport = {
    adapterVersions: { claude: "0.58.1" } as { claude: string },
    adapterRegistry: "https://npm.corp.example/repository/npm/",
  };
  const spec = resolveConfiguredAgentLaunch({ driver: "claude" }, transport);
  const { context } = contextFor("claude", spec);
  const probe = resolveModelProbeLaunch("probe-agent", context, { env: ENV, transport });
  expect(probe.ok).toBe(true);
  if (!probe.ok) return;
  expect(probe.agentCommand).toEqual(spec.agentArgv);
  expect(probe.identity.adapterVersion).toBe("0.58.1");
  expect(typeof probe.identity.adapterRegistryDigest).toBe("string");
  const plain = resolveModelProbeLaunch("probe-agent", context, { env: ENV });
  expect(plain.ok).toBe(true);
  if (!plain.ok) return;
  expect(plain.identity.adapterRegistryDigest).toBeUndefined();
  expect(plain.identity.resolvedAgentCommandDigest).toBe(probe.identity.resolvedAgentCommandDigest);
});

test("a preinstalled release wins the same way it does for a normal launch", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "adapter-probe-parity-"));
  try {
    const releaseId = createAdapterReleaseId("2.2.2", "https://registry.npmjs.org", "99999999-0000-4000-8000-000000000000");
    const release = join(runtimeRoot, "adapters", "codex", "releases", releaseId);
    const entry = join(release, "node_modules", "@agentclientprotocol", "codex-acp", "bin", "codex-acp.js");
    const node = join(runtimeRoot, "runtime", "node");
    await mkdir(dirname(entry), { recursive: true });
    await mkdir(dirname(node), { recursive: true });
    await writeFile(entry, "export {};\n");
    await writeFile(node, "#!/bin/sh\n");
    await chmod(node, 0o755);
    await writeFile(join(release, "installed.json"), JSON.stringify({
      schemaVersion: 1, id: "codex", packageName: "@agentclientprotocol/codex-acp", version: "2.2.2",
      releaseId, registry: "https://registry.npmjs.org", nodeExecutable: node,
      entryRelPath: relative(release, entry), installedAt: "2026-08-05T00:00:00.000Z",
    }));
    await writeFile(join(runtimeRoot, "adapters", "codex", "active.json"), JSON.stringify({ version: "2.2.2", releaseId, activatedAt: "now" }));
    const spec = resolveConfiguredAgentLaunch({ driver: "codex" }, undefined, { runtimeRoot });
    expect(spec.agentArgv?.join(" ")).toContain(entry);
    const { context } = contextFor("codex", spec);
    const probe = resolveModelProbeLaunch("probe-agent", context, { env: ENV });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.agentCommand).toEqual(spec.agentArgv);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("hermes reuses the shim argv", () => {
  const spec = resolveConfiguredAgentLaunch({ driver: "hermes" }, undefined, { platform: "darwin" });
  const { context } = contextFor("hermes", spec);
  const probe = resolveModelProbeLaunch("probe-agent", context, { env: ENV });
  expect(probe.ok).toBe(true);
  if (!probe.ok) return;
  expect(probe.agentCommand).toEqual(spec.agentArgv);
  expect(probe.agentCommand.slice(2)).toEqual(["hermes", "acp"]);
});

test("local fallback stays consistent with the normal launch either way", () => {
  const spec = resolveConfiguredAgentLaunch({ driver: "opencode" }, { preferLocalAgents: true });
  const { context } = contextFor("opencode", spec);
  const probe = resolveModelProbeLaunch("probe-agent", context, { env: ENV });
  if (spec.agentArgv) {
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.agentCommand).toEqual(["opencode", "acp"]);
  } else {
    expect(probe.ok).toBe(false);
  }
});

test("a unix raw command is probe-unavailable without leaking the command", () => {
  const spec = resolveConfiguredAgentLaunch(
    { driver: "claude", command: "my-claude --acp" },
    undefined,
    { platform: "darwin" },
  );
  expect(spec.rawCommand).toBe("my-claude --acp");
  const { context } = contextFor("claude", spec);
  const probe = resolveModelProbeLaunch("probe-agent", context, { env: ENV });
  expect(probe.ok).toBe(false);
  if (probe.ok) return;
  expect(probe.reason).toBe("probe-unavailable");
  expect(probe.message).not.toContain("my-claude --acp");
  expect(probe.identity.launchDigest).toBe(launchFingerprint(spec));
});

test("windows keeps the raw-command fail-closed rule for probes", () => {
  const single = resolveConfiguredAgentLaunch(
    { driver: "claude", command: "claude.exe" },
    undefined,
    { platform: "win32" },
  );
  const singleProbe = resolveModelProbeLaunch(
    "probe-agent",
    contextFor("claude", single).context,
    { env: ENV, platform: "win32" },
  );
  expect(singleProbe.ok).toBe(true);
  if (!singleProbe.ok) return;
  expect(singleProbe.agentCommand).toEqual(["claude.exe"]);

  const sticky = contextFor("claude", {
    agentCommand: "node C:/my agent/server.js",
    acpxAgent: "claude",
    rawCommand: "node C:/my agent/server.js",
  });
  const multi = resolveModelProbeLaunch("probe-agent", sticky.context, { env: ENV, platform: "win32" });
  expect(multi.ok).toBe(false);
  if (multi.ok) return;
  expect(multi.reason).toBe("probe-unavailable");
});

test("a bare driver resolves through the acpx registry, never a guessed table", () => {
  const bare = contextFor("gemini", { acpxAgent: "gemini" });
  expect(resolveModelProbeLaunch("probe-agent", bare.context, { env: ENV }).ok).toBe(false);

  const registry = resolveModelProbeLaunch("probe-agent", bare.context, {
    env: ENV,
    loadAgentRegistry: () => ({ resolve: (driver: string) => (driver === "gemini" ? ["gemini", "--acp"] : "") }),
  });
  expect(registry.ok).toBe(true);
  if (!registry.ok) return;
  expect(registry.agentCommand).toEqual(["gemini", "--acp"]);

  const raw = resolveModelProbeLaunch("probe-agent", bare.context, {
    env: ENV,
    loadAgentRegistry: () => ({ resolve: () => "gemini --acp" }),
  });
  expect(raw.ok).toBe(false);

  const broken = resolveModelProbeLaunch("probe-agent", bare.context, {
    env: ENV,
    loadAgentRegistry: () => { throw new Error("registry gone"); },
  });
  expect(broken.ok).toBe(false);
});

test("claude settingsPolicy flows into agentProcessEnv only when asked", () => {
  const base = contextFor("claude", {
    acpxAgent: "xacpx-managed-claude-test",
    agentCommand: "npx claude",
    agentArgv: ["npx", "claude"],
  }, { settingsPolicy: "full-user" });
  const withoutEnv = resolveModelProbeLaunch("probe-agent", base.context, { env: {} });
  expect(withoutEnv.ok).toBe(true);
  if (!withoutEnv.ok) return;
  expect(withoutEnv.agentProcessEnv).toBeUndefined();

  const full = resolveModelProbeLaunch("probe-agent", base.context, { env: {}, includeEnv: true });
  expect(full.ok).toBe(true);
  if (!full.ok) return;
  expect(full.agentProcessEnv?.["ACPX_CLAUDE_INCLUDE_USER_SETTINGS"]).toBe("1");

  const isolated = resolveModelProbeLaunch(
    "probe-agent",
    contextFor("claude", base.context.launch, { settingsPolicy: "isolated" }).context,
    {
      env: {},
      includeEnv: true,
      claudeEnv: { homeDir: "/nonexistent-test-home", writeProfile: () => {}, linkSessionState: () => {} },
    },
  );
  expect(isolated.ok).toBe(true);
  if (!isolated.ok) return;
  expect(typeof isolated.agentProcessEnv?.["CLAUDE_CONFIG_DIR"]).toBe("string");

  const providerOnly = resolveModelProbeLaunch(
    "probe-agent",
    contextFor("claude", base.context.launch, { settingsPolicy: "provider-only" }).context,
    { env: {}, includeEnv: true, claudeEnv: { homeDir: "/nonexistent-test-home", readTextFile: () => { throw new Error("no settings"); } } },
  );
  expect(providerOnly.ok).toBe(true);
  if (!providerOnly.ok) return;
  expect(providerOnly.agentProcessEnv).toBeUndefined();

  const modeled = resolveModelProbeLaunch(
    "probe-agent",
    contextFor("claude", base.context.launch, { settingsPolicy: "full-user", configuredModel: "claude-opus" }).context,
    { env: {}, includeEnv: true },
  );
  expect(modeled.ok).toBe(true);
  if (!modeled.ok) return;
  expect(modeled.agentProcessEnv?.["ANTHROPIC_MODEL"]).toBe("claude-opus");

  const codex = resolveModelProbeLaunch(
    "probe-agent",
    contextFor("codex", { acpxAgent: "codex", agentCommand: "npx", agentArgv: ["npx"] }).context,
    { env: {}, includeEnv: true },
  );
  expect(codex.ok).toBe(true);
  if (!codex.ok) return;
  expect(codex.agentProcessEnv).toBeUndefined();
});

test("settingsPolicy identity defaults match the resolver", () => {
  expect(normalizeProbeSettingsPolicy("claude", undefined)).toBe("provider-only");
  expect(normalizeProbeSettingsPolicy("claude", "isolated")).toBe("isolated");
  expect(normalizeProbeSettingsPolicy("codex", undefined)).toBe("none");
});

test("auth revision is presence-only: values never rotate or leak it", () => {
  expect(authRevisionForEnv({})).toBe(authRevisionForEnv({ UNRELATED: "x" }));
  expect(authRevisionForEnv({ OPENAI_API_KEY: "one" })).toBe(authRevisionForEnv({ OPENAI_API_KEY: "two" }));
  expect(authRevisionForEnv({ OPENAI_API_KEY: "one" })).not.toBe(authRevisionForEnv({}));
  expect(authRevisionForEnv({ OPENAI_API_KEY: "one" })).not.toContain("one");
});

test("probe identity is stable per input and rotates per argv", () => {
  const { context } = contextFor("codex", {
    acpxAgent: "codex",
    agentCommand: "npx codex@1",
    agentArgv: ["npx", "codex@1"],
  });
  const first = resolveModelProbeLaunch("probe-agent", context, { env: ENV });
  const second = resolveModelProbeLaunch("probe-agent", context, { env: ENV, cwd: "/repo" });
  expect(first.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(second.identity).toEqual(first.identity);
  expect(second.cwd).toBe("/repo");

  const moved = resolveModelProbeLaunch("probe-agent", context, { env: ENV, cwd: "/elsewhere" });
  expect(moved.ok).toBe(true);
  if (!moved.ok) return;
  expect(moved.cwd).toBe("/elsewhere");
  expect(moved.identity).toEqual(first.identity);

  const rotated = resolveModelProbeLaunch(
    "probe-agent",
    contextFor("codex", { acpxAgent: "codex", agentCommand: "npx codex@2", agentArgv: ["npx", "codex@2"] }).context,
    { env: ENV },
  );
  expect(rotated.ok).toBe(true);
  if (!rotated.ok) return;
  expect(rotated.identity.resolvedAgentCommandDigest).not.toBe(first.identity.resolvedAgentCommandDigest);

  const unavailable = resolveModelProbeLaunch("probe-agent", contextFor("codex", { acpxAgent: "codex" }).context, { env: ENV });
  expect(unavailable.ok).toBe(false);
  if (unavailable.ok) return;
  expect(unavailable.identity.resolvedAgentCommandDigest).not.toBe(first.identity.resolvedAgentCommandDigest);
});
