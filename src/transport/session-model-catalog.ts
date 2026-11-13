import type {
  AgentCapabilityProbeRequest,
  AgentCapabilityProbeResult,
  ResolvedSession,
  SessionModelState,
} from "./types";
import { modelRestoreFailure } from "./omp-model-recovery";

/** Probe seam: the transport's `probeAgentCapabilities`, nothing more. */
export type AgentCapabilityProbe = (
  input: AgentCapabilityProbeRequest,
) => Promise<AgentCapabilityProbeResult>;

/** A native session model read that cannot be trusted as a catalog. */
export class ModelCatalogProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelCatalogProtocolError";
  }
}

/** Structured read quality of a native session model advertisement. */
export type NativeModelRead =
  | { status: "complete"; current?: string; available: string[] }
  | { status: "missing" }
  | { status: "malformed"; error: ModelCatalogProtocolError };

/**
 * Classify a native `status --format json` payload without ever treating a
 * broken advertisement as an empty catalog: only an explicit empty
 * `availableModels` array is complete-and-empty. A missing field is missing,
 * anything else misshapen is malformed. Partially invalid entries are
 * filtered (reported via `onParseWarning`); an all-invalid list is
 * malformed. A non-string `model` yields no current model rather than
 * overwriting a known-good one with garbage.
 */
export function parseNativeModelCatalog(
  raw: unknown,
  onParseWarning?: (message: string) => void,
): NativeModelRead {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      status: "malformed",
      error: new ModelCatalogProtocolError("session model status is not an object"),
    };
  }
  const availableModels: unknown =
    "availableModels" in raw ? raw.availableModels : undefined;
  if (availableModels === undefined) return { status: "missing" };
  if (!Array.isArray(availableModels)) {
    return {
      status: "malformed",
      error: new ModelCatalogProtocolError("session model status has no availableModels array"),
    };
  }
  const available = availableModels.filter((entry): entry is string => typeof entry === "string");
  if (available.length === 0 && availableModels.length > 0) {
    return {
      status: "malformed",
      error: new ModelCatalogProtocolError("session model status advertises no parseable model ids"),
    };
  }
  const dropped = availableModels.length - available.length;
  if (dropped > 0) onParseWarning?.(`ignoring ${dropped} invalid availableModels entries`);
  const model: unknown = "model" in raw ? raw.model : undefined;
  return {
    status: "complete",
    ...(typeof model === "string" ? { current: model } : {}),
    available,
  };
}

/**
 * One strict `status --format json` read shared by both transports: invalid
 * JSON, a missing list, and a misshapen list all throw
 * `ModelCatalogProtocolError` instead of posing as an empty catalog. Only a
 * complete advertisement (possibly explicitly empty) returns.
 */
export function parseSessionStatusCatalog(
  stdout: string,
  label: string,
): { current?: string; available: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new ModelCatalogProtocolError(
      `session model status for ${label} was not valid JSON`,
      { cause: error },
    );
  }
  const read = parseNativeModelCatalog(raw);
  if (read.status === "complete") return { current: read.current, available: read.available };
  if (read.status === "missing") {
    throw new ModelCatalogProtocolError(
      `session model status for ${label} has no availableModels list`,
    );
  }
  throw read.error;
}

/** Read options shared by the control RPC and the chat `/model` path. */
export interface SessionModelReadOptions {
  /**
   * Skip the native-session read and re-probe the session's exact launch for a
   * verified-fresh catalog. Used when the native session cannot be restored or
   * the current catalog is known stale.
   */
  refresh?: boolean;
}

/**
 * The exact launch identity of a resolved session, minus its target model: a
 * cold adapter probe must not inherit the session's model override (the catalog
 * is agent-level) nor its alias (probes are alias-free by contract).
 */
export function sessionLaunchProbeRequest(
  session: ResolvedSession,
): AgentCapabilityProbeRequest {
  return {
    agent: session.agent,
    cwd: session.cwd,
    ...(session.driver !== undefined ? { driver: session.driver } : {}),
    ...(session.settingsPolicy !== undefined
      ? { settingsPolicy: session.settingsPolicy }
      : {}),
    ...(session.agentCommand !== undefined
      ? { agentCommand: session.agentCommand }
      : {}),
    ...(session.acpxAgent !== undefined ? { acpxAgent: session.acpxAgent } : {}),
    ...(session.rawCommand !== undefined ? { rawCommand: session.rawCommand } : {}),
    ...(session.agentArgv !== undefined ? { agentArgv: session.agentArgv } : {}),
  };
}

/**
 * Verified-fresh model catalog for a session, read by cold-probing its exact
 * launch. The current model is the session's own resolved value (persisted
 * state, never a runtime load); the available list comes from the live probe.
 * A failed probe throws its own diagnostic — a cached or unrelated list must
 * never be presented as freshly verified.
 */
export async function probeSessionModelCatalog(
  probe: AgentCapabilityProbe,
  session: ResolvedSession,
): Promise<SessionModelState> {
  const label = `agent "${session.agent}" session "${session.alias}"`;
  let result: AgentCapabilityProbeResult;
  try {
    result = await probe(sessionLaunchProbeRequest(session));
  } catch (error) {
    throw new Error(
      `model catalog refresh failed for ${label}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!result.ok) {
    throw new Error(
      `model catalog refresh failed for ${label}: ${result.failure}: ${result.message}`,
    );
  }
  return {
    current: session.model,
    available: result.models.map((model) => model.modelId),
  };
}

/**
 * The session's model catalog as the native session reports it.
 *
 * A broken native session surfaces as OMP's `Could not restore model <id>`; in
 * that one case the exact-launch probe replaces the read, so the caller still
 * gets a real catalog. Every other native failure is rethrown unchanged, and
 * a failing fallback reports the original error rather than a probe error.
 *
 * `coldFallbackWhenEmpty` covers the other broken shape: a native read that
 * succeeds but advertises nothing (acpx could not parse the session record).
 * The cold probe then supplies the catalog; if it fails, the empty native
 * result stands, because an empty list is not a failure.
 */
export async function readSessionModelCatalog(input: {
  session: ResolvedSession;
  /** Native-session read; absent when the transport cannot query it. */
  read?: () => Promise<SessionModelState>;
  /** Cold probe of the exact launch; absent when the transport cannot probe. */
  probe?: AgentCapabilityProbe;
  /** Skip the native read and cold-probe the exact launch instead. */
  refresh?: boolean;
  /** Probe the exact launch when the native read advertises no models. */
  coldFallbackWhenEmpty?: boolean;
}): Promise<SessionModelState> {
  const { session, read, probe } = input;
  if (input.refresh) {
    if (!probe) {
      throw new Error(
        "model catalog refresh requires a transport that can probe agent capabilities",
      );
    }
    return await probeSessionModelCatalog(probe, session);
  }
  if (!read) {
    // Transport can't query the session; fall back to the resolved model.
    return { current: session.model, available: [] };
  }
  let observed: { current?: string; available: string[] };
  try {
    observed = await read();
  } catch (error) {
    if (!probe || !modelRestoreFailure(error)) throw error;
    try {
      return await probeSessionModelCatalog(probe, session);
    } catch {
      throw error; // report the original native-session failure
    }
  }
  if (input.coldFallbackWhenEmpty && probe && observed.available.length === 0) {
    try {
      const probed = await probeSessionModelCatalog(probe, session);
      if (probed.available.length > 0) return probed;
    } catch {
      // An empty native catalog is not a failure; keep what the session said.
    }
  }
  return observed;
}
