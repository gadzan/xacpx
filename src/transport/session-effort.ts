import type { SessionEffortState } from "./types";

const EFFORT_CONFIG_IDS = new Set([
  "reasoning_effort",
  "effort",
  "thought_level",
  "thinking",
]);

type EffortConfigOption = SessionEffortState & { configId: string };

export interface SessionEffortReapplyInput {
  persisted?: string;
  observedCurrent?: string;
  advertised?: string[];
  /**
   * True when the next queue-owner launch will kill and respawn (fingerprint
   * change or no reusable owner). A replacement adapter can reset effort even
   * when the current record still matches, so write desired effort while cold.
   */
  ownerWillBeReplaced: boolean;
}

/**
 * Persisted `session.effort` is the user's desired value and can differ from
 * the adapter's advertised current — ControlService prefers persisted when it
 * is still advertised. Skip `acpx set` only when the live record already
 * matches AND the current owner will be reused. Otherwise return the value to
 * apply after cooling the owner: `acpx set` against a live owner can spawn a
 * second ACP process and break exclusive session leases (Reasonix).
 */
export function sessionEffortToReapply(input: SessionEffortReapplyInput): string | undefined {
  const effort = input.persisted?.trim();
  if (!effort) return undefined;
  if (!input.advertised?.includes(effort)) return undefined;
  if (input.observedCurrent === effort && !input.ownerWillBeReplaced) return undefined;
  return effort;
}

export function requireAdvertisedSessionEffort(raw: string, value: string): EffortConfigOption {
  const advertised = parseSessionEffortRecord(raw);
  if (!advertised) {
    throw new Error("the active agent does not advertise a reasoning-effort option");
  }
  if (!advertised.available.includes(value)) {
    throw new Error(`reasoning effort "${value}" is not advertised by the active agent`);
  }
  return advertised;
}

/** Locate the reasoning-effort select advertised by an ACP adapter in an acpx record. */
export function parseSessionEffortRecord(raw: string): EffortConfigOption | undefined {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(record) || !isRecord(record.acpx) || !Array.isArray(record.acpx.config_options)) {
    return undefined;
  }

  for (const candidate of record.acpx.config_options) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") continue;
    if (candidate.category !== "thought_level" && !EFFORT_CONFIG_IDS.has(candidate.id)) continue;
    const available = Array.isArray(candidate.options)
      ? candidate.options.flatMap(effortOptionValues)
      : [];
    return {
      configId: candidate.id,
      current: typeof candidate.currentValue === "string" ? candidate.currentValue : undefined,
      available,
    };
  }
  return undefined;
}

function effortOptionValues(option: unknown): string[] {
  if (!isRecord(option)) return [];
  if (typeof option.value === "string") return [option.value];
  return Array.isArray(option.options) ? option.options.flatMap(effortOptionValues) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
