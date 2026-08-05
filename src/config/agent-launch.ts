import { createHash } from "node:crypto";

/**
 * Structured description of how to launch an ACP agent through acpx.
 *
 * - `acpxAgent` is what acpx sees as the positional agent name: a bare built-in
 *   driver (codex, claude, pool, ...) or a xacpx-managed overlay alias that acpx
 *   resolves from `~/.acpx/config.json`'s `agents` node (see
 *   `src/transport/acpx-agent-overlay.ts`).
 * - Structured launches carry `agentArgv` (exact boundaries, Windows-safe) and
 *   `agentCommand` (the stable canonical identity acpx persists and keys its
 *   session records by).
 * - `rawCommand` is the Unix-only legacy escape hatch passed as acpx `--agent`.
 */
export interface AgentLaunchSpec {
  /** acpx positional agent: bare driver or xacpx-managed alias. */
  acpxAgent: string;
  /** Stable acpx session identity for explicit launches. */
  agentCommand?: string;
  /** Exact executable and argument boundaries for overlay/migration. */
  agentArgv?: string[];
  /** Unix-only legacy raw override. */
  rawCommand?: string;
}

// Same semantics as acpx `renderArgvIdentity()` (src/acp/client-process.ts):
// identity-safe tokens stay bare, everything else is JSON-quoted. xacpx must
// reproduce acpx's identity byte-for-byte or session records get re-keyed.
const IDENTITY_SAFE_ARG_RE = /^[A-Za-z0-9_@%+=:,./^~-]+$/u;

export function renderAgentArgvIdentity(argv: readonly string[]): string {
  return argv.map((arg) => (IDENTITY_SAFE_ARG_RE.test(arg) ? arg : JSON.stringify(arg))).join(" ");
}

/** argv must be a non-empty array of strings whose first element is non-empty. */
export function isValidAgentArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string") &&
    value[0]!.length > 0
  );
}

/** Content-addressed overlay alias: stable per canonical argv across processes
 * and platforms; only acpx-safe name characters. */
export function deriveAgentAlias(driver: string, argv: readonly string[]): string {
  const identity = renderAgentArgvIdentity(argv);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `xacpx-managed-${driver}-${hash}`;
}
