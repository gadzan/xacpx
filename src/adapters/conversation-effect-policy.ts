import { fileURLToPath } from "node:url";
import type { AgentConfig, TransportConfig } from "../config/types";
import { effectiveAdapterVersion } from "./adapter-catalog";
import { DEFAULT_ADAPTER_REGISTRY, effectiveAdapterRegistry } from "./adapter-registry";
import { unwrapAcpOutputGuardArgv } from "./acp-output-guard";

/** Versioned execution ceiling, not a Bot capability or permission origin. */
export const CLAUDE_READ_ONLY_POLICY = "claude-read-only-v1" as const;
export type EnforcedExecutionPolicy = typeof CLAUDE_READ_ONLY_POLICY;
export type RequestedFilesystemPolicy = "read-only" | "read-write";

export function supportsEnforcedReadOnly(
  agent: Pick<AgentConfig, "driver" | "command" | "argv"> | undefined,
  transport?: Pick<TransportConfig, "adapterVersions" | "adapterRegistry">,
): boolean {
  return agent?.driver === "claude" && !agent.command && agent.argv === undefined
    && effectiveAdapterVersion("claude", transport?.adapterVersions) === "0.78.0"
    && effectiveAdapterRegistry(transport?.adapterRegistry) === DEFAULT_ADAPTER_REGISTRY;
}

export function wrapReadOnlyAgentArgv(argv: readonly string[], moduleUrl = import.meta.url): string[] {
  const dist = moduleUrl.lastIndexOf("/dist/");
  const entry = moduleUrl.endsWith(".ts")
    ? new URL("./acp-read-only-guard-main.ts", moduleUrl)
    : new URL(dist >= 0
      ? `${moduleUrl.slice(0, dist + 6)}adapters/acp-read-only-guard-main.js`
      : "./acp-read-only-guard-main.js", moduleUrl);
  return [process.execPath, fileURLToPath(entry), "--", ...unwrapAcpOutputGuardArgv(argv)];
}

export function isReadOnlyAgentArgv(argv: readonly string[]): boolean {
  const inner = unwrapAcpOutputGuardArgv(argv);
  return inner[2] === "--" && /[/\\]acp-read-only-guard-main\.(?:ts|js)$/.test(inner[1] ?? "");
}

/** Exclusive SDK tool set. allowedTools alone would only auto-approve tools. */
export function claudeReadOnlyOptions(): Record<string, unknown> {
  return {
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["Read", "Glob", "Grep"],
    disallowedTools: ["mcp__*"],
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    agents: {},
    skills: [],
    toolAliases: {},
    additionalDirectories: [],
    allowDangerouslySkipPermissions: false,
    settings: { disableAllHooks: true, autoMemoryEnabled: false },
    extraArgs: { bare: null, "disable-slash-commands": null, restricted: null },
  };
}

type Rpc = Record<string, any>;
export type PolicyDecision = { forward: Rpc } | { reply: Rpc };
const denied = (message: Rpc): PolicyDecision => ({ reply: {
  jsonrpc: "2.0", id: message.id,
  error: { code: -32601, message: "accepted read-only execution forbids this capability" },
} });

function assertRpcObject(message: Rpc): void {
  // A JSON-RPC batch must not bypass per-request capability filtering.
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("read-only guard requires one RPC object per frame");
}

/** Every creation/resume gets the same ceiling; no client metadata survives. */
export function guardReadOnlyClientMessage(message: Rpc): PolicyDecision {
  assertRpcObject(message);
  if (typeof message.method !== "string") return { forward: message };
  const p = message.params ?? {};
  if (message.method === "initialize") return { forward: { ...message, params: {
    protocolVersion: p.protocolVersion,
    clientInfo: p.clientInfo,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
  } } };
  if (message.method === "session/new" || message.method === "session/load") {
    return { forward: { ...message, params: {
      cwd: p.cwd,
      ...(message.method === "session/load" ? { sessionId: p.sessionId } : {}),
      mcpServers: [],
      _meta: { claudeCode: { options: claudeReadOnlyOptions() } },
    } } };
  }
  if (message.method === "session/prompt") {
    // Built-in command dispatch is outside the model tool set. Never forward
    // command-shaped text, even if the caller tries to embed it in metadata.
    if (!Array.isArray(p.prompt) || p.prompt.some((block: any) =>
      block?.type !== "text" || typeof block.text !== "string" || block.text.trimStart().startsWith("/"))) {
      return denied(message);
    }
    return { forward: { ...message, params: { sessionId: p.sessionId, prompt: p.prompt } } };
  }
  if (message.method === "session/cancel") return { forward: {
    ...message, params: { sessionId: p.sessionId },
  } };
  if (message.method === "session/set_model") return { forward: {
    ...message, params: { sessionId: p.sessionId, modelId: p.modelId },
  } };
  if (message.method === "session/set_config_option" && ["model", "effort", "thinking"].includes(p.configId)) {
    return { forward: { ...message, params: { sessionId: p.sessionId, configId: p.configId, value: p.value } } };
  }
  return denied(message);
}

/** Native tools are restricted above; this closes the independent ACP surface. */
export function guardReadOnlyAgentMessage(message: Rpc): PolicyDecision {
  assertRpcObject(message);
  if (typeof message.method !== "string" && message.result?.agentCapabilities) {
    // acpx prefers advertised resume over load. Only load is rewritten with
    // the frozen SDK ceiling; do not advertise unsupported resume/fork or
    // interactive auth, MCP, subagent and provider-management capabilities.
    // Preserve top-level metadata (including typed terminal failure evidence).
    return { forward: { ...message, result: { ...message.result,
      agentCapabilities: { loadSession: message.result.agentCapabilities.loadSession === true, promptCapabilities: {} },
      authMethods: [],
    } } };
  }
  if (typeof message.method !== "string" || !("id" in message)) return { forward: message };
  if (message.method === "fs/read_text_file") return { forward: message };
  if (message.method === "session/request_permission") return { reply: {
    jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } },
  } };
  return denied(message);
}
