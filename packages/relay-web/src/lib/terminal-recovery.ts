// Browser recovery reducer — spec §14.6.
// Pure state machine: no I/O. The store applies `action` side effects
// (adapter resetAndReplay / write / resync RPC).
import {
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_REBASE_TOTAL_BYTES,
  TERMINAL_REBASE_CHUNK_BYTES,
  parseCanonicalBase64,
} from "@ganglion/xacpx-relay-protocol";

export type RecoveryPhase = "waiting" | "rebase" | "live" | "resyncing" | "exited";

export interface RecoveryState {
  generation: string;
  phase: RecoveryPhase;
  epoch?: number;
  expectedSequence?: number;
  expectedChunkIndex?: number;
  /** Declared on rebase-start; validated on rebase-end. */
  rebaseTotalBytes?: number;
  rebaseChunkCount?: number;
  rebaseCols?: number;
  rebaseRows?: number;
  rebaseAlternate?: boolean;
  rebaseNextSequence?: number;
  chunks?: Uint8Array[];
  decodedBytes?: number;
}

export type RecoveryInbound =
  | {
    kind: "rebase-start";
    generation: string;
    epoch: number;
    nextSequence: number;
    cols: number;
    rows: number;
    alternate: boolean;
    totalBytes: number;
    chunkCount: number;
  }
  | { kind: "rebase-chunk"; generation: string; epoch: number; index: number; dataBase64: string }
  | { kind: "rebase-end"; generation: string; epoch: number }
  | { kind: "bytes"; generation: string; epoch: number; sequence: number; dataBase64: string }
  | { kind: "exit" }
  | { kind: "resync-started" };

export type RecoveryAction =
  | { type: "none" }
  | { type: "apply-rebase"; keyframe: Uint8Array; cols: number; rows: number }
  | { type: "write-bytes"; data: Uint8Array }
  | { type: "request-resync"; reason: string }
  | { type: "ignore" };

export interface RecoveryStep {
  state: RecoveryState;
  action: RecoveryAction;
}

export function initialRecoveryState(generation: string): RecoveryState {
  return { generation, phase: "waiting" };
}

function resync(state: RecoveryState, reason: string): RecoveryStep {
  return {
    state: {
      generation: state.generation,
      phase: "resyncing",
    },
    action: { type: "request-resync", reason },
  };
}

/** Reduce one inbound recovery frame. Caller must apply `action` side effects. */
export function reduceRecovery(state: RecoveryState, inbound: RecoveryInbound): RecoveryStep {
  if (state.phase === "exited") {
    return { state, action: { type: "ignore" } };
  }

  if (inbound.kind === "exit") {
    return { state: { generation: state.generation, phase: "exited" }, action: { type: "none" } };
  }

  if (inbound.kind === "resync-started") {
    return {
      state: { generation: state.generation, phase: "resyncing" },
      action: { type: "none" },
    };
  }

  // Drop frames from a different generation unless we're waiting for a fresh open.
  if (inbound.generation !== state.generation) {
    return resync(state, "generation-mismatch");
  }

  if (inbound.kind === "rebase-start") {
    if (inbound.totalBytes > MAX_TERMINAL_REBASE_TOTAL_BYTES) {
      return resync(state, "rebase-too-large");
    }
    const expectedChunks =
      inbound.totalBytes === 0 ? 0 : Math.ceil(inbound.totalBytes / TERMINAL_REBASE_CHUNK_BYTES);
    if (inbound.chunkCount !== expectedChunks) {
      return resync(state, "rebase-chunk-count-mismatch");
    }
    return {
      state: {
        generation: state.generation,
        phase: "rebase",
        epoch: inbound.epoch,
        expectedChunkIndex: 0,
        rebaseTotalBytes: inbound.totalBytes,
        rebaseChunkCount: inbound.chunkCount,
        rebaseCols: inbound.cols,
        rebaseRows: inbound.rows,
        rebaseAlternate: inbound.alternate,
        rebaseNextSequence: inbound.nextSequence,
        chunks: [],
        decodedBytes: 0,
      },
      action: { type: "none" },
    };
  }

  if (state.phase === "resyncing") {
    // Only a new rebase-start (handled above) can leave resyncing.
    return { state, action: { type: "ignore" } };
  }

  if (inbound.kind === "rebase-chunk") {
    if (state.phase !== "rebase") {
      return resync(state, "chunk-outside-rebase");
    }
    if (inbound.epoch !== state.epoch) {
      return resync(state, "chunk-epoch-mismatch");
    }
    if (inbound.index !== state.expectedChunkIndex) {
      return resync(state, "chunk-index-mismatch");
    }
    const decoded = parseCanonicalBase64(inbound.dataBase64, TERMINAL_REBASE_CHUNK_BYTES);
    if (!decoded) {
      return resync(state, "chunk-base64-invalid");
    }
    const chunks = [...(state.chunks ?? []), decoded];
    const decodedBytes = (state.decodedBytes ?? 0) + decoded.byteLength;
    // Hard stop if we already exceeded the declared total mid-stream.
    if (decodedBytes > (state.rebaseTotalBytes ?? 0)) {
      return resync(state, "chunk-overflow");
    }
    return {
      state: {
        ...state,
        chunks,
        decodedBytes,
        expectedChunkIndex: (state.expectedChunkIndex ?? 0) + 1,
      },
      action: { type: "none" },
    };
  }

  if (inbound.kind === "rebase-end") {
    if (state.phase !== "rebase") {
      return resync(state, "end-outside-rebase");
    }
    if (inbound.epoch !== state.epoch) {
      return resync(state, "end-epoch-mismatch");
    }
    const chunkCount = state.chunks?.length ?? 0;
    if (chunkCount !== (state.rebaseChunkCount ?? -1)) {
      return resync(state, "end-chunk-count-mismatch");
    }
    const decodedBytes = state.decodedBytes ?? 0;
    if (decodedBytes !== (state.rebaseTotalBytes ?? -1)) {
      return resync(state, "end-byte-count-mismatch");
    }
    const keyframe = chunkCount === 0 ? new Uint8Array(0) : concatChunks(state.chunks!);
    const cols = state.rebaseCols ?? 80;
    const rows = state.rebaseRows ?? 24;
    const nextSequence = state.rebaseNextSequence ?? 0;
    return {
      state: {
        generation: state.generation,
        phase: "live",
        epoch: state.epoch,
        expectedSequence: nextSequence,
      },
      action: { type: "apply-rebase", keyframe, cols, rows },
    };
  }

  if (inbound.kind === "bytes") {
    if (state.phase !== "live") {
      // Spec: do not accept bytes until rebase completes.
      if (state.phase === "rebase") {
        return resync(state, "bytes-during-rebase");
      }
      return { state, action: { type: "ignore" } };
    }
    // Spec §14.6.6: a newer rebase replaces the live epoch; old-epoch frames are dropped.
    if (inbound.epoch !== state.epoch) {
      return { state, action: { type: "ignore" } };
    }
    if (inbound.sequence !== state.expectedSequence) {
      return resync(state, "sequence-gap");
    }
    const decoded = parseCanonicalBase64(inbound.dataBase64, MAX_TERMINAL_INPUT_BYTES);
    if (!decoded) {
      return resync(state, "bytes-base64-invalid");
    }
    return {
      state: { ...state, expectedSequence: (state.expectedSequence ?? 0) + 1 },
      action: { type: "write-bytes", data: decoded },
    };
  }

  return { state, action: { type: "ignore" } };
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
