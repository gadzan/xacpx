import type { SessionEffortState } from "./types";

const EFFORT_CONFIG_IDS = new Set([
  "reasoning_effort",
  "effort",
  "thought_level",
  "thinking",
]);

type EffortConfigOption = SessionEffortState & { configId: string };

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
      ? candidate.options.flatMap((option) =>
          isRecord(option) && typeof option.value === "string" ? [option.value] : [])
      : [];
    return {
      configId: candidate.id,
      current: typeof candidate.currentValue === "string" ? candidate.currentValue : undefined,
      available,
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
