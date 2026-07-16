export const RELAY_PROTOCOL_VERSION = 1;

export type EnvelopeKind = "req" | "res" | "event";

export interface RelayEnvelope {
  protocolVersion: number;
  kind: EnvelopeKind;
  /** Correlates res to req. Required for req/res; absent for event. */
  id?: string;
  /** Namespaced message type, e.g. "instance.sessions.list". */
  type: string;
  payload?: unknown;
  /** Hub wall-clock deadline (epoch ms) for this request. */
  requestDeadlineAt?: number;
  /** Conservative connector work budget, excluding Hub response headroom. */
  requestBudgetMs?: number;
}

export type DecodeEnvelopeResult =
  | { ok: true; envelope: RelayEnvelope }
  | { ok: false; error: "invalid-json" | "invalid-envelope" | "version-mismatch"; detail?: string };

export function encodeEnvelope(envelope: RelayEnvelope): string {
  return JSON.stringify(envelope);
}

export function decodeEnvelope(line: string): DecodeEnvelopeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!isEnvelopeShape(raw)) {
    return { ok: false, error: "invalid-envelope" };
  }
  if (raw.protocolVersion !== RELAY_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: "version-mismatch",
      detail: `expected protocolVersion ${RELAY_PROTOCOL_VERSION}, got ${raw.protocolVersion}`,
    };
  }
  return { ok: true, envelope: raw };
}

function isEnvelopeShape(value: unknown): value is RelayEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.protocolVersion !== "number" || !Number.isInteger(candidate.protocolVersion)) return false;
  if (candidate.kind !== "req" && candidate.kind !== "res" && candidate.kind !== "event") return false;
  if (typeof candidate.type !== "string" || candidate.type.trim().length === 0) return false;
  if (candidate.id !== undefined && typeof candidate.id !== "string") return false;
  if (
    candidate.requestDeadlineAt !== undefined
    && (
      typeof candidate.requestDeadlineAt !== "number"
      || !Number.isFinite(candidate.requestDeadlineAt)
      || candidate.requestDeadlineAt <= 0
    )
  ) return false;
  if (
    candidate.requestBudgetMs !== undefined
    && (
      typeof candidate.requestBudgetMs !== "number"
      || !Number.isFinite(candidate.requestBudgetMs)
      || candidate.requestBudgetMs <= 0
    )
  ) return false;
  if (
    (candidate.kind === "req" || candidate.kind === "res") &&
    (typeof candidate.id !== "string" || candidate.id.length === 0)
  )
    return false;
  return true;
}
