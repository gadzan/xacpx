import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";

import type { EngineSessionInput } from "../bridge-engine";
import type { ResolvedSession } from "../../../transport/types";

export function normalizePathForComparison(p?: string): string | undefined {
  if (!p) return undefined;
  const resolved = resolvePath(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Canonical physical identity for one acpx session: sessionKey +
 * normalized cwd + launch agent identity. Two logical aliases that resolve
 * to the same triple contend for the same physical fence and the same
 * durable queue-owner lifecycle — this is the grouping key for
 * cross-alias lifecycle decisions (remove transactions, sibling handoff).
 * It is deliberately Route-independent: callers pass the already-resolved
 * EngineSessionInput, the same shape the Bridge sends the engines.
 */
export function physicalFenceKeyForSession(input: EngineSessionInput): string {
  const normalizedCwd = normalizePathForComparison(input.cwd) ?? input.cwd ?? "";
  // Agent identity: prefer the exact launch identity the Runtime will use.
  // EngineSessionInput carries the resolved launch fields (agentCommand /
  // acpxAgent / rawCommand / agentArgv) from SessionService.toResolvedSession,
  // so the hash is stable for a given physical session.
  const agentId =
    (typeof input.agentCommand === "string" && input.agentCommand.length > 0 ? input.agentCommand : undefined) ??
    (typeof input.rawCommand === "string" && input.rawCommand.length > 0 ? input.rawCommand : undefined) ??
    (typeof input.acpxAgent === "string" && input.acpxAgent.length > 0 ? input.acpxAgent : undefined) ??
    (Array.isArray(input.agentArgv) && input.agentArgv.length > 0 ? input.agentArgv.join(String.fromCharCode(0)) : undefined) ??
    input.agent ??
    "";
  const sessionKey = input.name ?? "";
  const sep = String.fromCharCode(0);
  const raw = `${sessionKey}${sep}${normalizedCwd}${sep}${agentId}`;
  // 32 hex chars (128-bit) is enough to avoid collisions for fence namespace.
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/**
 * Physical lifecycle key for a daemon-side ResolvedSession. Projects exactly
 * the fields the Bridge forwards to the engines (see toParams /
 * withMcp) so the command layer groups aliases by the same identity the
 * fence will be claimed under — never by transport name alone.
 */
export function physicalLifecycleKeyForResolvedSession(session: ResolvedSession): string {
  return physicalFenceKeyForSession({
    agent: session.agent,
    cwd: session.cwd,
    name: session.transportSession,
    ...(session.agentCommand ? { agentCommand: session.agentCommand } : {}),
    ...(session.acpxAgent ? { acpxAgent: session.acpxAgent } : {}),
    ...(session.rawCommand ? { rawCommand: session.rawCommand } : {}),
    ...(session.agentArgv ? { agentArgv: session.agentArgv } : {}),
  });
}
