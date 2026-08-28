/**
 * Central tunable surface for the Discord channel.
 */

export interface DiscordTuning {
  /** Min interval between preview edit PATCH calls. */
  previewThrottleMs: number;
  /** Min chars before the first preview message is created. */
  minInitialChars: number;
  /** Max chars the preview message may hold before freezing. */
  previewMaxChars: number;
}

export const DEFAULT_DISCORD_TUNING: DiscordTuning = {
  previewThrottleMs: 1200,
  minInitialChars: 200,
  previewMaxChars: 2000,
};

export function resolveDiscordTuning(partial: Partial<DiscordTuning> | undefined): DiscordTuning {
  if (!partial) return { ...DEFAULT_DISCORD_TUNING };
  return { ...DEFAULT_DISCORD_TUNING, ...stripUndefined(partial) };
}

function stripUndefined<T extends object>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
