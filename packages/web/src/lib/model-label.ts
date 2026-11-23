// Known reasoning-effort suffixes. Agents advertise model ids inconsistently — some as
// `model[high]`, others as `model/medium` — so the composer's model chip looked different
// across sessions running different adapter versions.
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Display label for an agent-advertised model id.
 *
 * Normalizes a known reasoning-effort suffix written as `model[effort]` to the `model/effort`
 * form, so the chip reads consistently regardless of which adapter advertised it. This is
 * DISPLAY ONLY — callers keep the raw id for selection/comparison and send it back verbatim,
 * since the agent expects its own id. Bracketed suffixes that are NOT a known effort (e.g. a
 * context-window variant like `claude-opus-4-8[1m]`) are left untouched.
 */
export function formatModelLabel(id: string): string {
  const m = /^(.+)\[([a-z]+)\]$/.exec(id);
  if (m && EFFORTS.has(m[2])) return `${m[1]}/${m[2]}`;
  return id;
}
