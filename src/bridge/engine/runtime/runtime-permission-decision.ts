/**
 * acpx 0.20 lets a permission handler name the exact offered option
 * (`{ outcome: "selected", optionId }`); an id the agent never offered
 * cancels upstream. xacpx decides by outcome kind (policy rule, permission
 * mode, or the interactive channel), so the kind is mapped back onto the
 * agent's own option here — once, at the acpx boundary — instead of leaning
 * on upstream's kind-fallback table, which is free to change under us.
 *
 * The fallback order mirrors acpx's DECISION_FALLBACK_ORDER exactly, and a
 * kind with no offered option cancels exactly as upstream's decisionToResponse
 * does, so translation can only make the decision more explicit, never
 * different, for kind-derived decisions.
 *
 * Shapes mirror acpx's AcpPermissionDecision structurally without importing
 * acpx/runtime (G13: only runtime-adapter.ts may import it).
 */

export type RuntimePermissionOutcome =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | "cancel";

/** One offered ACP permission option. SDK v1 `PermissionOptionKind` has no `cancel`. */
export interface OfferedPermissionOption {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export const OFFERED_PERMISSION_KINDS: readonly OfferedPermissionOption["kind"][] = [
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
];

export type UpstreamPermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "allow_once" }
  | { outcome: "allow_always" }
  | { outcome: "reject_once" }
  | { outcome: "reject_always" }
  | { outcome: "cancel" };

/**
 * Offered options of an ACP `session/request_permission` payload, validated
 * once. An option without a usable id or kind can never be selected, so it is
 * dropped here rather than surfacing as a choosable outcome upstream.
 */
export function readOfferedPermissionOptions(raw: unknown): OfferedPermissionOption[] {
  const options = (raw as { options?: unknown } | null | undefined)?.options;
  if (!Array.isArray(options)) return [];
  const offered: OfferedPermissionOption[] = [];
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const { optionId, kind } = option as { optionId?: unknown; kind?: unknown };
    if (typeof optionId !== "string" || optionId.length === 0) continue;
    if (typeof kind !== "string") continue;
    if (!OFFERED_PERMISSION_KINDS.includes(kind as OfferedPermissionOption["kind"])) continue;
    offered.push({ optionId, kind: kind as OfferedPermissionOption["kind"] });
  }
  return offered;
}

function selectOffered(
  offered: readonly OfferedPermissionOption[],
  ...kinds: readonly OfferedPermissionOption["kind"][]
): { outcome: "selected"; optionId: string } | undefined {
  for (const kind of kinds) {
    const match = offered.find((option) => option.kind === kind);
    if (match) return { outcome: "selected", optionId: match.optionId };
  }
  return undefined;
}

/**
 * Translate an xacpx outcome onto the agent's offered options. Exact kind
 * first, then its sibling kind (allow_always falls back to allow_once and
 * back), then cancel — the same resolution acpx applies to a kind-based
 * decision, made explicit at our boundary.
 */
export function toUpstreamPermissionDecision(
  outcome: RuntimePermissionOutcome,
  offered: readonly OfferedPermissionOption[],
): UpstreamPermissionDecision {
  switch (outcome) {
    case "cancel":
      return { outcome: "cancel" };
    case "allow_once":
      return selectOffered(offered, "allow_once", "allow_always") ?? { outcome: "cancel" };
    case "allow_always":
      return selectOffered(offered, "allow_always", "allow_once") ?? { outcome: "cancel" };
    case "reject_once":
      return selectOffered(offered, "reject_once", "reject_always") ?? { outcome: "cancel" };
    case "reject_always":
      return selectOffered(offered, "reject_always", "reject_once") ?? { outcome: "cancel" };
  }
}
