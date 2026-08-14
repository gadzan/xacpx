import type { SessionEffortState } from "./types";

const EFFORT_CONFIG_IDS = new Set([
  "reasoning_effort",
  "effort",
  "thought_level",
  "thinking",
]);

type EffortConfigOption = SessionEffortState & { configId: string };

/**
 * Reapply persisted effort only on a cold queue owner. `acpx set` against a
 * live owner falls back to spawning a second ACP process and `session/resume`.
 * Agents with exclusive session leases (Reasonix) reject that as "in use by
 * another process" — the warm owner already holds the configured effort.
 *
 * Skip the warmth probe when there is no effort: `isSessionWarm` is a
 * management command and must not run on every prompt.
 */
export async function sessionEffortToReapply(
  effort: string | undefined,
  isWarm: () => Promise<boolean>,
): Promise<string | undefined> {
  const value = effort?.trim();
  if (!value) return undefined;
  return (await isWarm()) ? undefined : value;
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
