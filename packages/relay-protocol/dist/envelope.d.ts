export declare const RELAY_PROTOCOL_VERSION = 1;
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
export type DecodeEnvelopeResult = {
    ok: true;
    envelope: RelayEnvelope;
} | {
    ok: false;
    error: "invalid-json" | "invalid-envelope" | "version-mismatch";
    detail?: string;
};
export declare function encodeEnvelope(envelope: RelayEnvelope): string;
export declare function decodeEnvelope(line: string): DecodeEnvelopeResult;
