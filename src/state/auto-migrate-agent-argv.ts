import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isDerivedAgentArgv,
  renderAgentArgvIdentity,
  deriveAgentAlias,
} from "../config/agent-launch";
import { resolveConfiguredAgentLaunch } from "../config/resolve-agent-command";
import type { AgentConfig, TransportConfig } from "../config/types";
import type { AppLogger } from "../logging/app-logger";
import { createAcpxAgentRegistryLoader } from "../transport/agent-registry";
import { resolveAcpxHomeDir } from "../transport/acpx-session-files";
import { withPrivateFileLock, writePrivateFileAtomic } from "../util/private-file";
import { ensureAgentOverlays, type AcpxAgentOverlayEntry } from "../transport/acpx-agent-overlay";

import type { LogicalSession } from "./types";

export type StateArgvMigrationStatus = "noop" | "backfilled" | "rejected";

export interface StateArgvMigrationEvaluation {
  status: StateArgvMigrationStatus;
  /** Set when status is "backfilled": the exact argv to persist. */
  targetArgv?: string[];
  /** Human-readable reason; set when status is "rejected". */
  reason?: string;
}

/**
 * Platform-neutral pure decision: can this `LogicalSession`'s recorded raw
 * command be safely backfilled with a structured argv without changing the
 * acpx session identity?
 *
 * A session is migratable iff:
 * - it has a recorded raw `transport_agent_command` (the Windows fail-closed
 *   trigger) that is either a single token whose canonical identity round-trips
 *   losslessly (`[command]` re-renders to `command`), OR a multi-token command,
 * - `transport_agent_argv` is not already set (or is set but the session is
 *   missing the canonical `transport_acpx_agent` — that is a repair case),
 * - and at least one of the two identity-proving sources is available:
 *     a. `agents[session.agent]` already has an `argv` whose canonical identity
 *        equals the recorded command (config source), OR
 *     b. the on-disk acpx session record indexed by `transport_session` has
 *        `agent_argv` and an `agent_command` matching the recorded command,
 *        AND the canonical identity of that `agent_argv` equals
 *        `agent_command` (rejects corrupt/inconsistent records where the two
 *        fields disagree).
 *
 * Full Path A sticky state requires BOTH `transport_agent_argv` AND the
 * canonical `transport_acpx_agent` (`deriveAgentAlias(driver, argv)`).
 * `resolveLaunchSpec` step 2 needs both; argv-only is NOT done.
 *
 * Anything else is rejected: silently rewriting argv on a record we cannot
 * prove is the same launch would key acpx onto a different session file and
 * orphan the existing record's history.
 */
export function evaluateStateSessionArgvMigration(
  session: LogicalSession,
  agentConfig: AgentConfig | undefined,
  acpxRecordArgv: string[] | undefined,
  options?: { canonicalAcpxAgent?: string },
): StateArgvMigrationEvaluation {
  if (
    Array.isArray(session.transport_agent_argv) &&
    session.transport_agent_argv.length > 0 &&
    session.transport_agent_argv.every((entry) => typeof entry === "string")
  ) {
    const existingArgv = session.transport_agent_argv as string[];
    const existingAcpx =
      typeof session.transport_acpx_agent === "string" && session.transport_acpx_agent.length > 0
        ? session.transport_acpx_agent
        : undefined;
    const canonical = options?.canonicalAcpxAgent;
    // Fully migrated only when argv is present AND the sticky alias matches
    // the canonical content-hash (or no canonical was supplied — treat any
    // non-empty alias as complete for callers that don't compute one).
    if (
      existingAcpx !== undefined &&
      (canonical === undefined || existingAcpx === canonical)
    ) {
      return { status: "noop" };
    }
    // argv-only, or alias missing / non-canonical → repair by re-persisting
    // the existing argv so the apply phase can write the canonical alias.
    return { status: "backfilled", targetArgv: [...existingArgv] };
  }
  const command = session.transport_agent_command;
  if (typeof command !== "string" || command.length === 0) {
    return { status: "noop" };
  }
  if (!/\s/.test(command)) {
    // Single-token raw command. A single-element argv is lossless ONLY when
    // the canonical identity round-trips (e.g. "kimi" -> ["kimi"]). Tokens
    // outside the identity-safe charset (Windows paths with backslashes,
    // quotes, etc.) render JSON-quoted, so `[command]` would re-key the acpx
    // record — those must fall through to the config-argv / acpx-record
    // identity proof below and fail closed when none exists.
    const argv = [command];
    if (renderAgentArgvIdentity(argv) === command) {
      return { status: "backfilled", targetArgv: argv };
    }
  }
  if (agentConfig === undefined) {
    return {
      status: "rejected",
      reason: `agent "${session.agent}" is no longer configured`,
    };
  }
  if (Array.isArray(agentConfig.argv) && agentConfig.argv.length > 0) {
    const identity = renderAgentArgvIdentity(agentConfig.argv);
    if (identity !== command) {
      return {
        status: "rejected",
        reason: `agent config argv identity (${identity}) does not match recorded command (${command})`,
      };
    }
    return { status: "backfilled", targetArgv: [...agentConfig.argv] };
  }
  if (typeof agentConfig.command === "string" && agentConfig.command.length > 0) {
    return {
      status: "rejected",
      reason: `agent "${session.agent}" config still uses raw command; migrate it to argv manually`,
    };
  }
  if (acpxRecordArgv === undefined) {
    return {
      status: "rejected",
      reason: `cannot prove identity without an acpx session record matching "${command}"`,
    };
  }
  // Identity proof from acpx record: argv's canonical identity must equal
  // the recorded command. Catches corrupt/inconsistent records (e.g.
  // agent_command = "kimi acp" but agent_argv = ["other", "--agent"]) where
  // adopting the argv would silently re-key the session onto a different
  // acpx record and orphan the existing history.
  const argvIdentity = renderAgentArgvIdentity(acpxRecordArgv);
  if (argvIdentity !== command) {
    return {
      status: "rejected",
      reason: `acpx record argv identity (${argvIdentity}) does not match recorded command (${command}); record is inconsistent`,
    };
  }
  return { status: "backfilled", targetArgv: [...acpxRecordArgv] };
}

/**
 * Returns the parsed acpx session record matching the given transport_session
 * name. The `expectedCommand` (when provided) is used to disambiguate when
 * multiple records share the same name — this is the documented behavior
 * of acpx: two sessions can share a transport_session name but differ in
 * `agent_command` (e.g. aliasing on top of one another). The reader must
 * fail closed on ambiguity (return null) rather than picking arbitrarily.
 */
export type AcpxRecordReader = (
  transportSession: string,
  expectedCommand?: string,
) => Promise<Record<string, unknown> | null>;

export interface StateArgvMigrationConfigUpdate {
  agent: string;
  argv: string[];
}

/**
 * Where a driver's effective default argv came from. Provenance decides
 * whether the migration may elevate that argv into explicit
 * `agents.<name>.argv`:
 *
 * - `bare-acpx-registry`: acpx's builtin registry default (kimi →
 *   `["kimi","acp"]`). Stable across pin bumps — safe to elevate.
 * - `explicit-config`: the agent already carries its own `argv` in config.
 *   Elevating just mirrors what is already there (state backfill).
 * - `derived`: managed adapter npx pin, hermes shim, or opencode/kilocode
 *   local fallback. `SessionService` deliberately recomputes these on
 *   restart so the session identity follows the CURRENT pin/config —
 *   freezing one into explicit argv would make future adapter-version or
 *   `preferLocalAgents` changes silently ineffective. NEVER elevated.
 */
export type DefaultArgvSource = "explicit-config" | "bare-acpx-registry" | "derived";

export interface DefaultArgvResolution {
  argv: string[];
  source: DefaultArgvSource;
}

export interface StateArgvMigrationPlanEntry {
  alias: string;
  agent: string;
  /**
   * Canonical argv identity for the per-agent safety check. This is
   * `renderAgentArgvIdentity(argv)` if the session already has
   * `transport_agent_argv`, otherwise the recorded raw `transport_agent_command`
   * itself (which is also the single-token raw form). Undefined only
   * for sessions that have neither argv nor a recorded command.
   *
   * The check exists because `resolveLaunchSpec` step 3 (config argv)
   * beats step 4 (recorded raw command) — writing `agents.<name>.argv`
   * would silently re-key any non-sticky session whose identity does
   * not match. So every non-sticky session with a target identity for
   * the same agent must agree on it.
   */
  argvIdentity?: string;
  /**
   * True iff the session is sticky (has both `transport_agent_argv` and
   * `transport_acpx_agent`, and its argv is not derived from a managed
   * pin). Sticky sessions bypass config argv via `resolveLaunchSpec`
   * step 2 and are not affected by writing `agents.<name>.argv` — so
   * they are excluded from the per-agent safety check.
   */
  isSticky: boolean;
  /** The pure-decision evaluation: backfill / reject / noop. */
  evaluation: StateArgvMigrationEvaluation;
}

export interface StateArgvMigrationResult {
  migrated: Array<{ alias: string; agent: string; argv: string[]; acpxAgent: string }>;
  skipped: Array<{ alias: string; agent?: string; reason: string }>;
  configUpdates: StateArgvMigrationConfigUpdate[];
  /**
   * Non-fatal I/O issues that prevented part of the migration. The daemon path
   * logs each one and continues; the CLI path surfaces them on stderr and
   * exits non-zero so operator tooling never silently hides a real failure.
   */
  errors: string[];
}

export interface MigrateStateAgentArgvDeps {
  statePath: string;
  configPath: string;
  /** Acpx sessions dir; defaults to `<acpxHome>/.acpx/sessions`. */
  acpxSessionsDir?: string;
  /** Tests inject this; default reads + parses `<sessionsDir>/<index.json>` + the matched record file. */
  readAcpxRecord?: AcpxRecordReader;
  /** Tests inject this; default is `node:fs/promises.readFile(path, "utf8")`. */
  readFile?: (path: string) => Promise<string>;
  /**
   * Provision the session-local acpx overlays (`xacpx-managed-*` entries)
   * into acpx's config. Production default calls `ensureAgentOverlays` with
   * the real `~/.acpx/config.json`. Tests inject a no-op or a fixture to
   * avoid touching the real acpx home.
   */
  provisionOverlays?: (entries: AcpxAgentOverlayEntry[]) => Promise<void>;
  logger: AppLogger;
  /** When true, every write is skipped and only the plan is returned. */
  dryRun?: boolean;
  /** Runtime root for the `isDerivedAgentArgv` shared classification
   * (managed adapter pin detection, preinstalled-adapter identity check).
   * Defaults to `dirname(configPath)`. */
  runtimeRoot?: string;
  /** Platform for the same classification. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * Compute the argv a brand-new session of this agent would launch with,
   * plus its provenance (bare-acpx-registry / explicit-config / derived).
   * Defaults to `computeDefaultAgentArgv`. Tests inject this to avoid PATH /
   * registry dependencies. A bare-array return is accepted for backward
   * compat and is treated as `bare-acpx-registry` (the only auto-elevatable
   * source besides explicit-config); tests that need the derived case return
   * a `DefaultArgvResolution`.
   */
  resolveDefaultArgv?: (
    agentName: string,
    fullConfig: Record<string, unknown>,
    platform: NodeJS.Platform,
    runtimeRoot: string,
  ) => DefaultArgvResolution | string[] | undefined;
}

/** Normalize a seam return into a `DefaultArgvResolution` (or undefined). */
function toDefaultArgvResolution(
  value: DefaultArgvResolution | string[] | undefined,
): DefaultArgvResolution | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return { argv: value, source: "bare-acpx-registry" };
  return value;
}

/**
 * I/O seam over `evaluateStateSessionArgvMigration`. Reads `state.json` and
 * `config.json`, plans a per-session Path A migration, provisions session-local
 * `xacpx-managed-*` overlays into `~/.acpx/config.json`, then writes state.
 *
 * Atomicity:
 * - Overlay writes go through `ensureAgentOverlays` (acpx config lock).
 * - State writes are wrapped in `withPrivateFileLock`; inside the lock the
 *   state file is re-read fresh and every planned session patch is re-validated
 *   against the on-disk record. A concurrent daemon write between the initial
 *   planning read and the lock acquire cannot silently clobber unrelated
 *   state (`chat_contexts`, `orchestration`, `scheduled_tasks`) because only
 *   the targeted `sessions` subtree is touched in the new document.
 * - xacpx `config.json` is never mutated (Path A is session-local).
 *
 * Fail-soft in the daemon path: any I/O error is collected in `result.errors`
 * AND logged via the logger; the daemon continues to start so a transient
 * disk issue does not break boot. The CLI path surfaces the same `errors`
 * list on stderr and exits non-zero so operator tooling never silently hides
 * a real failure. (Session overlay *replay* at startup is fail-closed
 * separately in `autoMigrateArgv`.)
 */
export async function migrateStateAgentArgv(
  deps: MigrateStateAgentArgvDeps,
): Promise<StateArgvMigrationResult> {
  const result: StateArgvMigrationResult = {
    migrated: [],
    skipped: [],
    configUpdates: [],
    errors: [],
  };

  const sessionsDir =
    deps.acpxSessionsDir ?? join(resolveAcpxHomeDir(), ".acpx", "sessions");
  const readAcpxRecord = deps.readAcpxRecord ?? defaultReadAcpxRecord(sessionsDir);
  const readFile = deps.readFile ?? defaultReadFile;
  // Provision session-local acpx overlays into the user's `~/.acpx/config.json`
  // by default. Tests inject `provisionOverlays` to avoid touching the real
  // acpx home and to assert on the entries.
  const provisionOverlays = deps.provisionOverlays ?? (async (entries: AcpxAgentOverlayEntry[]): Promise<void> => {
    await ensureAgentOverlays(entries);
  });
  // Shared classification inputs (used both in the planning bucket's
  // isSticky check and the fresh-state per-agent recheck). Must agree
  // with `SessionService.resolveLaunchSpec`'s derived/custom split
  // or the safety set is a strict superset of step 3's reach.
  const runtimeRoot = deps.runtimeRoot ?? join(deps.configPath, "..");
  const platform = deps.platform ?? process.platform;

  // === Planning phase (no locks) ===

  const initialStateRaw = await safeReadText(
    readFile,
    deps.statePath,
    "state.json",
    result.errors,
    deps.logger,
  );
  if (initialStateRaw === null) return result;
  const initialStateParsed = safeParseJson(initialStateRaw, "state.json", result.errors, deps.logger);
  if (initialStateParsed === undefined) return result;
  if (!isRecord(initialStateParsed)) {
    pushError(result, deps.logger, "state.argv_migration.parse_failed",
      "state.json top-level is not an object; skipping argv migration",
      { statePath: deps.statePath }, undefined);
    return result;
  }
  const initialSessions = initialStateParsed.sessions;
  if (!isRecord(initialSessions)) return result;

  const configAgents = await readConfigAgentsMap(readFile, deps.configPath, result, deps.logger);
  // Load the full config too — the per-agent default-launch check needs
  // `config.transport` (for managed pin detection). Read once here and
  // pass to the bucket.
  const fullConfigRaw = await readFullConfig(readFile, deps.configPath, result, deps.logger);
  const fullConfig = fullConfigRaw ?? { agents: {} };

  const plan: StateArgvMigrationPlanEntry[] = [];
  for (const [alias, rawSession] of Object.entries(initialSessions)) {
    if (!isRecord(rawSession)) continue;
    const session = rawSession as unknown as LogicalSession;
    const agentName = typeof session.agent === "string" ? session.agent : "";
    if (!agentName) continue;
    const agentConfigRaw = isRecord(configAgents[agentName])
      ? configAgents[agentName]
      : undefined;
    const command = session.transport_agent_command;
    // Only fetch the acpx record when it can actually decide the outcome:
    // either config has no argv to match against, or config argv is missing.
    const acpxRecordArgv = await maybeReadAcpxRecordArgv(
      session,
      agentConfigRaw,
      command,
      readAcpxRecord,
      result.errors,
      deps.logger,
    );
    const existingArgv =
      Array.isArray(session.transport_agent_argv) &&
      session.transport_agent_argv.length > 0 &&
      session.transport_agent_argv.every((e) => typeof e === "string")
        ? (session.transport_agent_argv as string[])
        : undefined;
    const driverFromConfig =
      isRecord(agentConfigRaw) && typeof agentConfigRaw.driver === "string"
        ? agentConfigRaw.driver
        : undefined;
    const driverForDerived = driverFromConfig ?? agentName;
    // Path A sticky bypass still uses the shared derived/custom split so a
    // managed-pin argv is never treated as a finished migration.
    const isStickyByRecorded =
      typeof session.transport_acpx_agent === "string" &&
      session.transport_acpx_agent.length > 0 &&
      existingArgv !== undefined;
    const isSticky = isStickyByRecorded && !isDerivedAgentArgv(
      driverForDerived,
      existingArgv,
      runtimeRoot,
      platform,
    );
    const canonicalAcpxAgent = existingArgv
      ? deriveAgentAlias(driverForDerived, existingArgv)
      : undefined;
    const evaluation = evaluateStateSessionArgvMigration(
      session,
      normalizeAgentConfig(agentConfigRaw),
      acpxRecordArgv,
      canonicalAcpxAgent !== undefined ? { canonicalAcpxAgent } : undefined,
    );
    let argvIdentity: string | undefined;
    if (existingArgv) {
      argvIdentity = renderAgentArgvIdentity(existingArgv);
    } else if (typeof command === "string" && command.length > 0) {
      argvIdentity = command;
    }

    plan.push({
      alias,
      agent: agentName,
      ...(argvIdentity !== undefined ? { argvIdentity } : {}),
      isSticky,
      evaluation,
    });
  }

  const resolveDefaultArgv =
    deps.resolveDefaultArgv ??
    ((agentName: string, raw: Record<string, unknown>, plat: NodeJS.Platform, root: string) =>
      computeDefaultAgentArgv(agentName, raw, plat, root));
  // Normalize the seam return (tests may pass bare arrays) into a resolution
  // carrying provenance, which per-session planning uses to decide elevation.
  const resolveDefaultArgvNormalized = (
    agentName: string,
    raw: Record<string, unknown>,
    plat: NodeJS.Platform,
    root: string,
  ): DefaultArgvResolution | undefined =>
    toDefaultArgvResolution(resolveDefaultArgv(agentName, raw, plat, root));
  const { sessionUpdates } = planSessionUpdates(
    plan,
    result,
    fullConfig,
    platform,
    runtimeRoot,
    resolveDefaultArgvNormalized,
  );
  if (deps.dryRun) {
    for (const update of sessionUpdates) {
      result.migrated.push({
        alias: update.alias,
        agent: update.agent,
        argv: update.argv,
        acpxAgent: update.acpxAgent,
      });
    }
    return result;
  }

  // === Apply phase ===
//
// All writes happen inside the same `withPrivateFileLock` acquisition on
// the state file. Ordering:
//   1. Re-read state fresh inside the lock.
//   2. Validate every planned session update against the fresh record.
//      Any session that no longer matches (deleted, retargeted, command
//      changed, argv changed) is reported as a skip; if any update fails
//      validation, we abort the WHOLE migration — no state write, no
//      overlay write — so the existing state and acpx config stay in sync.
//   3. Provision the new session overlays (`xacpx-managed-<driver>-<hash>`
//      entries) into `~/.acpx/config.json` so acpx can resolve
//      `--agent <alias>` to the exact argv. If provisioning throws, abort
//      the whole transaction — we never write state pointing at an alias
//      acpx cannot resolve.
//   4. Write state with the validated sessions (including
//      `transport_acpx_agent` + `transport_agent_argv`); preserve every
//      other top-level key from the fresh snapshot. No `config.json`
//      write happens — the migration is purely session-local so future
//      sessions of the same driver continue to honor acpx global /
//      `.acpxrc.json` project overrides.
//
// The state lock prevents concurrent daemon `state.json` writes from
// interleaving between any of the steps. The overlay provision acquires
// acpx config's own proper-lockfile (`withPrivateFileLock` inside
// `ensureAgentOverlays`); the lock order is state → acpx config, held
// one at a time — no deadlock.

if (sessionUpdates.length > 0) {
  try {
    await withPrivateFileLock(deps.statePath, async (writeLocked) => {
      const freshRaw = await safeReadText(
        readFile,
        deps.statePath,
        "state.json",
        result.errors,
        deps.logger,
      );
      if (freshRaw === null) {
        // State file went away between planning read and lock acquire.
        // Nothing to migrate; nothing to write. config was not touched.
        return;
      }
      const freshParsed = safeParseJson(freshRaw, "state.json", result.errors, deps.logger);
      if (freshParsed === undefined) return;
      if (!isRecord(freshParsed)) {
        pushError(result, deps.logger, "state.argv_migration.parse_failed",
          "fresh state.json top-level is not an object; argv migration aborted",
          { statePath: deps.statePath }, undefined);
        return;
      }
      const freshSessions = freshParsed.sessions;
      if (!isRecord(freshSessions)) {
        pushError(result, deps.logger, "state.argv_migration.parse_failed",
          "fresh state.json sessions is not an object; argv migration aborted",
          { statePath: deps.statePath }, undefined);
        return;
      }

      // (2) Validate every planned update against the fresh record. Path A is
      // per-session: an invalid session is skipped individually; other planned
      // sessions still proceed. Aborting the whole batch is no longer required
      // because we never write a global `agents.<name>.argv` that could re-key
      // siblings.
      const validated: typeof sessionUpdates = [];
      for (const update of sessionUpdates) {
        const fresh = freshSessions[update.alias];
        if (!isRecord(fresh)) {
          result.skipped.push({
            alias: update.alias,
            agent: update.agent,
            reason: `fresh state: session alias "${update.alias}" no longer exists`,
          });
          continue;
        }
        const freshAgent = typeof fresh.agent === "string" ? fresh.agent : undefined;
        if (freshAgent !== update.agent) {
          result.skipped.push({
            alias: update.alias,
            agent: update.agent,
            reason: `fresh state: session "${update.alias}" agent changed from "${update.agent}" to "${freshAgent}"`,
          });
          continue;
        }
        const expectedIdentity = renderAgentArgvIdentity(update.argv);
        const cmd = typeof fresh.transport_agent_command === "string"
          ? fresh.transport_agent_command
          : undefined;
        const existingArgv = fresh.transport_agent_argv;
        const existingArgvOk =
          Array.isArray(existingArgv) &&
          existingArgv.length > 0 &&
          renderAgentArgvIdentity(existingArgv as string[]) === expectedIdentity;
        // Command must still match when present. When the session is an
        // argv-only repair candidate, allow unset command if argv already
        // proves the identity.
        if (cmd !== undefined && cmd !== expectedIdentity) {
          result.skipped.push({
            alias: update.alias,
            agent: update.agent,
            reason: `fresh state: session "${update.alias}" recorded command changed (was "${expectedIdentity}", now "${cmd}")`,
          });
          continue;
        }
        if (cmd === undefined && !existingArgvOk) {
          result.skipped.push({
            alias: update.alias,
            agent: update.agent,
            reason: `fresh state: session "${update.alias}" recorded command changed (was "${expectedIdentity}", now "(unset)")`,
          });
          continue;
        }
        if (Array.isArray(existingArgv) && existingArgv.length > 0) {
          const existingIdentity = renderAgentArgvIdentity(existingArgv as string[]);
          if (existingIdentity !== expectedIdentity) {
            result.skipped.push({
              alias: update.alias,
              agent: update.agent,
              reason: `fresh state: session "${update.alias}" argv changed from target ${JSON.stringify(update.argv)} to ${JSON.stringify(existingArgv)}`,
            });
            continue;
          }
          const existingAcpxAgent = fresh.transport_acpx_agent;
          if (
            typeof existingAcpxAgent === "string" &&
            existingAcpxAgent === update.acpxAgent
          ) {
            // Fully migrated (argv + canonical alias). Count as success;
            // no state rewrite needed for this session.
            result.migrated.push({
              alias: update.alias,
              agent: update.agent,
              argv: update.argv,
              acpxAgent: update.acpxAgent,
            });
            continue;
          }
          // argv matches but alias missing/wrong → repair below.
        }
        validated.push(update);
      }
      if (validated.length === 0) {
        return;
      }

      // (3) Provision the new session overlays into `~/.acpx/config.json` so
      // acpx can resolve `--agent <alias>` to the exact argv. Deduped by
      // alias (content-hash on argv). MUST run before the state write — a
      // state session that points at a non-existent alias would fail to
      // launch on Windows. If provisioning throws, abort the whole
      // transaction (no state write).
      const newOverlayEntries: AcpxAgentOverlayEntry[] = [];
      const overlaySeen = new Set<string>();
      for (const update of validated) {
        if (overlaySeen.has(update.acpxAgent)) continue;
        overlaySeen.add(update.acpxAgent);
        newOverlayEntries.push({ alias: update.acpxAgent, argv: update.argv });
      }
      if (newOverlayEntries.length > 0) {
        try {
          await provisionOverlays(newOverlayEntries);
        } catch (error) {
          pushError(result, deps.logger, "state.argv_migration.overlay_provision_failed",
            "failed to provision session-local acpx overlays; argv migration aborted (no state write)",
            { error: errorMessage(error) }, error);
          return;
        }
      }

      // (4) Write state with the validated sessions. Persist BOTH
      // `transport_acpx_agent` AND `transport_agent_argv` so
      // `resolveLaunchSpec` step 2 (recorded argv sticky) launches the
      // session via the overlay alias — fixing the Windows fail-closed
      // throw. Preserve every other top-level key from the fresh
      // snapshot. Queue `migrated` entries locally and commit to
      // `result.migrated` only AFTER writeLocked resolves successfully.
      const queuedMigrated: Array<{ alias: string; agent: string; argv: string[]; acpxAgent: string }> = [];
      const nextSessions: Record<string, unknown> = { ...freshSessions };
      for (const update of validated) {
        const fresh = nextSessions[update.alias];
        if (!isRecord(fresh)) continue; // defensive
        nextSessions[update.alias] = {
          ...fresh,
          transport_acpx_agent: update.acpxAgent,
          transport_agent_argv: [...update.argv],
        };
        queuedMigrated.push(update);
      }
      const next: Record<string, unknown> = { ...freshParsed, sessions: nextSessions };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      await writeLocked(serialized);
      // State write succeeded. Commit queued migrated entries to result.
      for (const update of queuedMigrated) {
        result.migrated.push({
          alias: update.alias,
          agent: update.agent,
          argv: update.argv,
          acpxAgent: update.acpxAgent,
        });
      }
    });
  } catch (error) {
    // The state lock acquire, fresh re-read, or final writeLocked threw
    // after the config patch had already been committed. By the time we
    // land here, config.json may have been written (and result.configUpdates
    // populated). State.json may be unchanged OR partially written —
    // `writePrivateFileAtomic` does temp+rename which is atomic on POSIX
    // and best-effort on Windows where the fallback direct write can
    // leave a partial file. State did NOT complete successfully; the
    // operator must verify state.json, not assume "no writes applied".
    pushError(result, deps.logger, "state.argv_migration.write_failed",
      "argv migration failed during the state write step; state.json write did not complete successfully and may be unchanged or partially written. A new acpx overlay may have been provisioned and is now referenced only by sessions that did not get persisted.",
      { statePath: deps.statePath }, error);
  }
}

return result;
}

/**
 * Path A per-session planning. Each session is decided independently:
 *
 *   - noop (already has argv + canonical alias) => nothing
 *   - rejected (cannot prove identity) => skip that session only
 *   - backfilled / repair, argv matches current non-derived default =>
 *     session-local structured migration (`deriveAgentAlias` + overlay +
 *     persist `transport_acpx_agent` + `transport_agent_argv`)
 *   - backfilled but derived default => skip (stay re-derivable)
 *   - backfilled but argv != current default => skip (fail closed)
 *
 * Sibling sessions of the same agent no longer gate each other: Path A never
 * writes global `agents.<name>.argv`, so one session's alias cannot re-key
 * another. Overlay entries are deduped later by alias/hash.
 */
function planSessionUpdates(
  plan: StateArgvMigrationPlanEntry[],
  result: StateArgvMigrationResult,
  fullConfig: Record<string, unknown>,
  platform: NodeJS.Platform,
  runtimeRoot: string,
  resolveDefaultArgv: (agentName: string, fullConfig: Record<string, unknown>, platform: NodeJS.Platform, runtimeRoot: string) => DefaultArgvResolution | undefined,
): {
  sessionUpdates: Array<{ alias: string; agent: string; driver: string; argv: string[]; acpxAgent: string }>;
} {
  const sessionUpdates: Array<{ alias: string; agent: string; driver: string; argv: string[]; acpxAgent: string }> = [];

  for (const entry of plan) {
    if (entry.evaluation.status === "noop") {
      continue;
    }
    if (entry.evaluation.status !== "backfilled" || !entry.evaluation.targetArgv) {
      result.skipped.push({
        alias: entry.alias,
        agent: entry.agent,
        reason:
          entry.evaluation.reason ??
          `cannot prove argv identity for session "${entry.alias}"`,
      });
      continue;
    }

    const agent = entry.agent;
    const argv = [...entry.evaluation.targetArgv];
    const agentConfigRaw = isRecord(fullConfig.agents)
      ? (fullConfig.agents as Record<string, unknown>)[agent]
      : undefined;
    const driver = isRecord(agentConfigRaw) && typeof agentConfigRaw.driver === "string"
      ? agentConfigRaw.driver
      : agent;
    const defaultResolution = resolveDefaultArgv(agent, fullConfig, platform, runtimeRoot);
    const defaultArgv = defaultResolution?.argv;
    const matchesDefault =
      defaultArgv !== undefined &&
      defaultArgv.length === argv.length &&
      defaultArgv.every((token, index) => token === argv[index]);

    if (matchesDefault && defaultResolution!.source === "derived") {
      result.skipped.push({
        alias: entry.alias,
        agent,
        reason: `agent "${agent}" planned argv identity (${renderAgentArgvIdentity(argv)}) matches a derived launch (managed pin / hermes shim / local fallback); session-local alias would freeze a launch that should stay recomputed on restart — left untouched (migrate manually if needed)`,
      });
      continue;
    }
    if (!matchesDefault) {
      result.skipped.push({
        alias: entry.alias,
        agent,
        reason: `agent "${agent}" planned argv identity (${renderAgentArgvIdentity(argv)}) does not match the current driver's default launch (${defaultArgv === undefined ? "unknown" : renderAgentArgvIdentity(defaultArgv)}); refusing to write a session-local argv that the daemon would launch but that does not match the current launch — migrate this agent manually`,
      });
      continue;
    }

    sessionUpdates.push({
      alias: entry.alias,
      agent,
      driver,
      argv: [...argv],
      acpxAgent: deriveAgentAlias(driver, argv),
    });
  }

  return { sessionUpdates };
}

async function readConfigAgentsMap(
  readFile: (path: string) => Promise<string>,
  configPath: string,
  result: StateArgvMigrationResult,
  logger: AppLogger,
): Promise<Record<string, unknown>> {
  if (typeof configPath !== "string" || configPath.length === 0) return {};
  const raw = await safeReadText(readFile, configPath, "config.json", result.errors, logger);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    pushError(result, logger, "state.argv_migration.config_read_failed",
      "config.json is not valid JSON; argv migration will rely on acpx records only",
      { configPath }, error);
    return {};
  }
  if (isRecord(parsed) && isRecord(parsed.agents)) return parsed.agents;
  return {};
}

async function readFullConfig(
  readFile: (path: string) => Promise<string>,
  configPath: string,
  result: StateArgvMigrationResult,
  logger: AppLogger,
): Promise<Record<string, unknown> | null> {
  if (typeof configPath !== "string" || configPath.length === 0) return null;
  const raw = await safeReadText(readFile, configPath, "config.json", result.errors, logger);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    pushError(result, logger, "state.argv_migration.config_read_failed",
      "config.json is not valid JSON; argv migration will rely on acpx records only",
      { configPath }, error);
    return null;
  }
}

// Lazy, cached loader for acpx's agent registry. Loaded lazily so the
// migration still works (with a narrower safety set) when the acpx runtime
// cannot be required, and so `require("acpx/runtime")` never runs at import
// time in tests that inject `resolveDefaultArgv`.
const loadAcpxAgentRegistry = createAcpxAgentRegistryLoader();

function computeDefaultAgentArgv(
  agentName: string,
  rawConfig: Record<string, unknown>,
  platform: NodeJS.Platform,
  runtimeRoot: string,
): DefaultArgvResolution | undefined {
  const agents = isRecord(rawConfig.agents) ? rawConfig.agents : {};
  const agentRaw = agents[agentName];
  if (!isRecord(agentRaw)) return undefined;
  const driver = typeof agentRaw.driver === "string" ? agentRaw.driver : "";
  if (!driver) return undefined;
  // Skip agents that have an explicit raw command — those are
  // command-based, not argv-based. The migration should not try to
  // elevate argv for them (the user has a raw command intentionally).
  if (typeof agentRaw.command === "string" && agentRaw.command.length > 0) {
    return undefined;
  }
  const hasExplicitArgv =
    Array.isArray(agentRaw.argv) &&
    agentRaw.argv.length > 0 &&
    agentRaw.argv.every((e) => typeof e === "string");
  const agentConfig: AgentConfig = {
    driver,
    ...(hasExplicitArgv ? { argv: agentRaw.argv as string[] } : {}),
  };
  const transport = isRecord(rawConfig.transport) ? (rawConfig.transport as Partial<TransportConfig>) : undefined;
  const spec = resolveConfiguredAgentLaunch(
    agentConfig,
    transport as TransportConfig,
    { platform, runtimeRoot },
  );
  if (spec.agentArgv) {
    // Structured launch without an explicit agent.argv is one of the
    // DERIVED sources (managed adapter npx pin, hermes shim, opencode /
    // kilocode local fallback). resolveLaunchSpec deliberately recomputes
    // these on restart so the session identity follows the current
    // pin/config — the migration must NOT freeze one into explicit argv.
    return {
      argv: [...spec.agentArgv],
      source: hasExplicitArgv ? "explicit-config" : "derived",
    };
  }
  // Bare acpx builtin driver: the daemon spawns it as a bare positional and
  // acpx resolves the launch from its builtin registry (kimi -> ["kimi",
  // "acp"]). That is the argv a brand-new session of this driver would
  // record, so it is the correct oracle for the elevation check.
  // (Note: acpx-level user overrides in `~/.acpx/config.json` — global
  // `agents.<driver>` entries and project `.acpxrc.json` entries — only
  // affect NEW bare sessions created after the migration. The migration
  // does NOT write global `agents.<name>.argv`; migrated historical
  // sessions get a session-local alias so they keep their existing
  // launch identity, while future sessions of the same driver continue
  // to resolve through acpx and honor any user overrides — global or
  // per-cwd project.)
  // acpx versions differ in what the registry's resolve() returns: newer
  // builds return a structured argv array, older ones (<=0.12) return the
  // command string. Handle both; for the string form, split into tokens only
  // when the canonical identity round-trips losslessly (registry defaults are
  // plain space-separated tokens, never quoted).
  const registry = loadAcpxAgentRegistry();
  if (!registry) return undefined;
  const resolved = registry.resolve(driver);
  if (Array.isArray(resolved)) {
    return { argv: [...resolved], source: "bare-acpx-registry" };
  }
  if (typeof resolved === "string" && resolved.length > 0) {
    const tokens = resolved.split(/\s+/).filter((entry) => entry.length > 0);
    if (tokens.length > 0 && renderAgentArgvIdentity(tokens) === resolved) {
      return { argv: tokens, source: "bare-acpx-registry" };
    }
  }
  return undefined;
}

async function safeReadText(
  readFile: (path: string) => Promise<string>,
  path: string,
  label: string,
  errors: string[],
  logger: AppLogger,
): Promise<string | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    pushErrorRaw(errors, logger, "state.argv_migration.read_failed",
      `failed to read ${label}; argv migration aborted`,
      { path }, error);
    return null;
  }
}

function safeParseJson(
  raw: string,
  label: string,
  errors: string[],
  logger: AppLogger,
): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    pushErrorRaw(errors, logger, "state.argv_migration.parse_failed",
      `${label} is not valid JSON; argv migration aborted`,
      { contentLength: raw.length }, error);
    return undefined;
  }
}

function pushError(
  result: StateArgvMigrationResult,
  logger: AppLogger,
  event: string,
  message: string,
  context: Record<string, unknown>,
  error: unknown,
): void {
  pushErrorRaw(result.errors, logger, event, message, context, error);
}

function pushErrorRaw(
  errors: string[],
  logger: AppLogger,
  event: string,
  message: string,
  context: Record<string, unknown>,
  error: unknown,
): void {
  const humanMessage = `${message}${error ? `: ${errorMessage(error)}` : ""}`;
  errors.push(humanMessage);
  void logger.warn(event, message, {
    ...context,
    ...(error ? { message: errorMessage(error) } : {}),
  }).catch(() => {});
}

async function maybeReadAcpxRecordArgv(
  session: LogicalSession,
  agentConfigRaw: Record<string, unknown> | undefined,
  command: unknown,
  readAcpxRecord: AcpxRecordReader,
  errors: string[],
  logger: AppLogger,
): Promise<string[] | undefined> {
  if (typeof command !== "string" || command.length === 0) return undefined;
  // Lossless single-token commands are backfilled directly by the pure
  // evaluator as [command]; no record corroboration is needed. Anything
  // else (multi-token, or single-token that does NOT round-trip losslessly
  // such as a Windows path) must consult the acpx record below to prove the
  // planned argv keeps the same identity.
  if (!/\s/.test(command) && renderAgentArgvIdentity([command]) === command) {
    return undefined;
  }
  // If the agent already carries an argv whose identity matches the recorded
  // command, we don't need the acpx record as a corroborating source.
  if (agentConfigRaw !== undefined) {
    const argv = agentConfigRaw.argv;
    if (Array.isArray(argv) && argv.every((entry) => typeof entry === "string") && argv.length > 0) {
      const identity = renderAgentArgvIdentity(argv as string[]);
      if (identity === command) return undefined;
    }
  }
  const transportSession = typeof session.transport_session === "string" ? session.transport_session : "";
  if (!transportSession) return undefined;
  let record: Record<string, unknown> | null;
  try {
    record = await readAcpxRecord(transportSession, command);
  } catch (error) {
    // I/O failure is a real problem (issue 3 fix): the troubleshooting path
    // needs to see it on stderr and exit non-zero, not just see the
    // generic "cannot prove identity" skip.
    pushErrorRaw(errors, logger, "state.argv_migration.acpx_record_read_failed",
      `failed to read acpx session record for ${transportSession}; will rely on config only`,
      { transportSession }, error);
    return undefined;
  }
  if (!record) return undefined; // missing — no proof available
  const argv = record.agent_argv;
  if (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.every((entry) => typeof entry === "string") &&
    typeof record.agent_command === "string" &&
    record.agent_command === command
  ) {
    // Issue 4 fix: the record's argv and agent_command must agree. A
    // corrupt/inconsistent record (e.g. agent_command = "kimi acp" but
    // agent_argv = ["other", "--agent"]) cannot be trusted as identity
    // proof — refuse and let resolveLaunchSpec keep failing closed.
    const argvIdentity = renderAgentArgvIdentity(argv as string[]);
    if (argvIdentity !== record.agent_command) {
      return undefined;
    }
    return argv as string[];
  }
  return undefined;
}

function normalizeAgentConfig(raw: unknown): AgentConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const driver = typeof raw.driver === "string" ? raw.driver : "";
  if (!driver) return undefined;
  const argv = Array.isArray(raw.argv) && raw.argv.every((entry) => typeof entry === "string") && raw.argv.length > 0
    ? (raw.argv as string[])
    : undefined;
  const command = typeof raw.command === "string" && raw.command.length > 0 ? raw.command : undefined;
  return {
    driver,
    ...(argv ? { argv } : {}),
    ...(command ? { command } : {}),
  };
}

function defaultReadAcpxRecord(sessionsDir: string): AcpxRecordReader {
  // The acpx sessions directory exposes two artifacts:
  //   - `<encodeURIComponent(acpx_record_id)>.json` — the canonical record
  //   - `index.json` — a name→file map maintained by acpx
  // state.json has `transport_session` (which equals the record's `name`
  // field), but not `acpx_record_id`. Use the index to map name→file.
  //
  // Multiple records can share the same `name` (e.g. when an alias is
  // reused on top of an older session that has since been reaped, or when
  // acpx is restarted and a new session accidentally reuses the name).
  // The old impl collapsed these to a single `Map<name, file>` and lost
  // the earlier ones — which silently returned the wrong record's argv
  // to the migration and broke identity proof. Now we keep all candidates
  // and disambiguate by the supplied `expectedCommand` (the session's
  // `transport_agent_command`). On ambiguity, return null and let the
  // caller report "cannot prove identity".
  //
  // I/O failures (other than ENOENT for missing files) and JSON parse
  // errors are propagated to the caller as thrown exceptions so the
  // migration can surface them on stderr and exit non-zero. Returning
  // null silently here would hide the most likely cause of "cannot
  // prove identity" — a corrupt index or a permission error on a record
  // file.
  const indexCandidatesByName = new Map<string, Array<{ file: string; agentCommand?: string }>>();
  let indexLoaded = false;

  const loadIndex = async (): Promise<Map<string, Array<{ file: string; agentCommand?: string }>>> => {
    if (indexLoaded) return indexCandidatesByName;
    const indexPath = join(sessionsDir, "index.json");
    let raw: string;
    try {
      raw = await readFile(indexPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        indexLoaded = true;
        return indexCandidatesByName;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      // Corrupt index.json: surface as a real I/O error.
      throw new Error(
        `failed to parse acpx session index at ${indexPath}: ${errorMessage(error)}`,
      );
    }
    if (isRecord(parsed) && Array.isArray(parsed.entries)) {
      for (const entry of parsed.entries) {
        if (
          isRecord(entry) &&
          typeof entry.name === "string" &&
          typeof entry.file === "string"
        ) {
          const list = indexCandidatesByName.get(entry.name) ?? [];
          list.push({
            file: entry.file,
            ...(typeof entry.agentCommand === "string" ? { agentCommand: entry.agentCommand } : {}),
          });
          indexCandidatesByName.set(entry.name, list);
        }
      }
    }
    indexLoaded = true;
    return indexCandidatesByName;
  };

  return async (transportSession: string, expectedCommand?: string) => {
    const candidates = await loadIndex();
    const list = candidates.get(transportSession) ?? [];
    if (list.length === 0) return null;
    // Disambiguate by expectedCommand when available; otherwise we can
    // only safely pick a candidate when there is exactly one.
    const matches = expectedCommand !== undefined
      ? list.filter((c) => c.agentCommand === expectedCommand)
      : list;
    if (matches.length !== 1) {
      // Ambiguous (or zero) — fail closed rather than picking arbitrarily.
      return null;
    }
    const file = matches[0]!.file;
    const raw = await readFile(join(sessionsDir, file), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  };
}

async function defaultReadFile(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-exported for tests that want to verify the same writer that the daemon
// uses (writePrivateFileAtomic uses fsync + temp+rename). Not currently
// consumed by the migration directly because every state write goes through
// the lock's `writeLocked` callback, but keeping the import here documents the
// invariant (state is never written without going through that helper) and
// silences the unused-import linter.
void writePrivateFileAtomic;