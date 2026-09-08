/**
 * Unified acpx embedding-host policy (plan B5, acpx 0.15.1): the two host-side
 * ceilings both engine lanes share — the CLI queue-owner lane and the Runtime
 * worker lane. Values land in the owner/worker HOST process environment (they
 * are read by the acpx embedding client / TerminalManager), never in
 * agentProcessEnv (the agent-child-only overlay).
 */

/** Config-surface shape: mirrors TransportConfig's two advanced options. */
export interface AcpxHostPolicy {
  acpxMaxIncomingMessageBytes?: number | null;
  acpxTerminalMaxOutputBytes?: number | null;
}

function checkedByteLimit(name: string, value: number | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer byte count (0 = unlimited); got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Host process environment fragment for an acpx owner. Empty when the policy
 * is unset (follow upstream defaults). Throws fail-closed on invalid values
 * so a misconfigured ceiling can never silently widen into `0`/unlimited.
 */
export function resolveAcpxHostPolicyEnv(policy: AcpxHostPolicy): Record<string, string> {
  const incoming = checkedByteLimit("acpxMaxIncomingMessageBytes", policy.acpxMaxIncomingMessageBytes);
  const terminal = checkedByteLimit("acpxTerminalMaxOutputBytes", policy.acpxTerminalMaxOutputBytes);
  return {
    ...(incoming !== undefined ? { ACPX_MAX_ACP_MESSAGE_BYTES: String(incoming) } : {}),
    ...(terminal !== undefined ? { ACPX_TERMINAL_MAX_OUTPUT_BYTES: String(terminal) } : {}),
  };
}

/**
 * Spread-ready queue-owner base env for launcher construction:
 * `{ baseEnv }` when the policy sets anything, otherwise `{}` so the
 * launcher default (live process.env) stays bit-identical.
 */
export function queueOwnerBaseEnvOption(
  policy: AcpxHostPolicy,
  base: NodeJS.ProcessEnv = process.env,
): { baseEnv: NodeJS.ProcessEnv } | Record<string, never> {
  const hostPolicyEnv = resolveAcpxHostPolicyEnv(policy);
  if (Object.keys(hostPolicyEnv).length === 0) return {};
  return { baseEnv: { ...base, ...hostPolicyEnv } };
}
