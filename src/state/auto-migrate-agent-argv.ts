import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isDerivedAgentArgv,
  renderAgentArgvIdentity,
} from "../config/agent-launch";
import { resolveConfigPathForCurrentEnv } from "../config/config-path";
import type { AgentConfig } from "../config/types";
import type { AppLogger } from "../logging/app-logger";
import { resolveAcpxHomeDir } from "../transport/acpx-session-files";
import { withPrivateFileLock, writePrivateFileAtomic } from "../util/private-file";

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
 * - it has a recorded multi-token raw `transport_agent_command` (the Windows
 *   fail-closed trigger; single-token or absent commands are fine),
 * - `transport_agent_argv` is not already set,
 * - and at least one of the two identity-proving sources is available:
 *     a. `agents[session.agent]` already has an `argv` whose canonical identity
 *        equals the recorded command (config source), OR
 *     b. the on-disk acpx session record indexed by `transport_session` has
 *        `agent_argv` and an `agent_command` matching the recorded command,
 *        AND the canonical identity of that `agent_argv` equals
 *        `agent_command` (rejects corrupt/inconsistent records where the two
 *        fields disagree).
 *
 * Anything else is rejected: silently rewriting argv on a record we cannot
 * prove is the same launch would key acpx onto a different session file and
 * orphan the existing record's history.
 */
export function evaluateStateSessionArgvMigration(
  session: LogicalSession,
  agentConfig: AgentConfig | undefined,
  acpxRecordArgv: string[] | undefined,
): StateArgvMigrationEvaluation {
  if (
    Array.isArray(session.transport_agent_argv) &&
    session.transport_agent_argv.length > 0
  ) {
    return { status: "noop" };
  }
  const command = session.transport_agent_command;
  if (typeof command !== "string" || command.length === 0) {
    return { status: "noop" };
  }
  if (!/\s/.test(command)) {
    return { status: "noop" };
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

/** Returns the parsed acpx session record matching the given transport_session name. */
export type AcpxRecordReader = (transportSession: string) => Promise<Record<string, unknown> | null>;

export interface StateArgvMigrationConfigUpdate {
  agent: string;
  argv: string[];
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
  migrated: Array<{ alias: string; agent: string; argv: string[] }>;
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
  /** Patch the parsed raw config object; default delegates to `ConfigStore.patchRaw` (locked). */
  patchConfig?: (mutate: (raw: Record<string, unknown>) => void) => Promise<void>;
  logger: AppLogger;
  /** When true, every write is skipped and only the plan is returned. */
  dryRun?: boolean;
  /** Runtime root for the `isDerivedAgentArgv` shared classification
   * (managed adapter pin detection, preinstalled-adapter identity check).
   * Defaults to `dirname(configPath)`. */
  runtimeRoot?: string;
  /** Platform for the same classification. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * I/O seam over `evaluateStateSessionArgvMigration`. Reads `state.json` and
 * `config.json`, plans the migration, writes config first then state.
 *
 * Atomicity:
 * - Config writes go through `ConfigStore.patchRaw` which acquires the config
 *   proper-lockfile and re-reads inside the lock.
 * - State writes are wrapped in `withPrivateFileLock`; inside the lock the
 *   state file is re-read fresh and every planned session patch is re-validated
 *   against the on-disk record. A concurrent daemon write between the initial
 *   planning read and the lock acquire cannot silently clobber unrelated
 *   state (`chat_contexts`, `orchestration`, `scheduled_tasks`) because only
 *   the targeted `sessions` subtree is touched in the new document.
 *
 * Fail-soft in the daemon path: any I/O error is collected in `result.errors`
 * AND logged via the logger; the daemon continues to start so a transient
 * disk issue does not break boot. The CLI path surfaces the same `errors`
 * list on stderr and exits non-zero so operator tooling never silently hides
 * a real failure.
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
  const patchConfig = deps.patchConfig ?? defaultPatchConfig(deps.configPath);
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
    const evaluation = evaluateStateSessionArgvMigration(
      session,
      normalizeAgentConfig(agentConfigRaw),
      acpxRecordArgv,
    );

    // Per-agent safety fields. A session is STICKY (immune to config argv
    // step 3 override) iff:
    //   1. it has both transport_acpx_agent and transport_agent_argv, AND
    //   2. its argv is NOT derived (not a managed pin, hermes shim, or
    //      opencode/kilocode local fallback — those argvs reset to
    //      undefined in resolveLaunchSpec step 2 and fall through to
    //      step 3).
    // `isDerivedAgentArgv` is the SAME function SessionService uses, so
    // the safety set is exactly the set of sessions that step 3 cannot
    // reach after we write agents.<name>.argv. The classification
    // keys on the AGENT DRIVER, not the agent name.
    const existingArgv =
      Array.isArray(session.transport_agent_argv) &&
      session.transport_agent_argv.length > 0 &&
      session.transport_agent_argv.every((e) => typeof e === "string")
        ? (session.transport_agent_argv as string[])
        : undefined;
    const isStickyByRecorded =
      typeof session.transport_acpx_agent === "string" &&
      session.transport_acpx_agent.length > 0 &&
      existingArgv !== undefined;
    const driverFromConfig =
      isRecord(agentConfigRaw) && typeof agentConfigRaw.driver === "string"
        ? agentConfigRaw.driver
        : undefined;
    const driverForDerived = driverFromConfig ?? agentName;
    const isSticky = isStickyByRecorded && !isDerivedAgentArgv(
      driverForDerived,
      existingArgv,
      runtimeRoot,
      platform,
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

  const { agentArgvByName, sessionUpdates } = aggregatePerAgent(plan, result);
  if (deps.dryRun) {
    for (const [name, argv] of agentArgvByName) {
      result.configUpdates.push({ agent: name, argv: [...argv] });
    }
    for (const update of sessionUpdates) {
      result.migrated.push(update);
    }
    return result;
  }

  // === Apply phase ===
//
// All writes (config + state) happen inside the same `withPrivateFileLock`
// acquisition on the state file. Ordering:
//   1. Re-read state fresh inside the lock.
//   2. Validate every planned session update against the fresh record.
//      Any session that no longer matches (deleted, retargeted, command
//      changed, argv changed) is reported as a skip; if any update fails
//      validation, we abort the WHOLE migration — no config write, no
//      state write — so the existing state and config stay in sync.
//   3. Patch config (acquires its own lock briefly). If the mutator
//      silently skipped an agent (agent removed, raw command present,
//      argv identity conflict), abort BEFORE writing state — otherwise
//      we'd persist `transport_agent_argv` that points at an argv the
//      config won't have.
//   4. Write state with the validated sessions; preserve every other
//      top-level key from the fresh snapshot.
//
// The state lock prevents concurrent daemon `state.json` writes from
// interleaving between any of the four steps. Config writes happen with
// state lock held; a `config` lock is acquired only briefly inside
// `patchConfig` (which already re-reads under its own lock). No deadlock:
// the daemon's own state writes never take the config lock.

if (sessionUpdates.length > 0 || agentArgvByName.size > 0) {
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

      // (2) Validate every planned update against the fresh record. If any
      // session fails validation, ABORT — no config write, no state write.
      // This prevents the half-state where config has argv but state has no
      // matching session.
      const validated: typeof sessionUpdates = [];
      let anyInvalid = false;
      for (const update of sessionUpdates) {
        const fresh = freshSessions[update.alias];
        if (!isRecord(fresh)) {
          result.skipped.push({
            alias: update.alias,
            agent: update.agent,
            reason: `fresh state: session alias "${update.alias}" no longer exists`,
          });
          anyInvalid = true;
          continue;
        }
        const freshAgent = typeof fresh.agent === "string" ? fresh.agent : undefined;
        if (freshAgent !== update.agent) {
          result.skipped.push({
            alias: update.alias,
            agent: update.agent,
            reason: `fresh state: session "${update.alias}" agent changed from "${update.agent}" to "${freshAgent}"`,
          });
          anyInvalid = true;
          continue;
        }
        const expectedIdentity = renderAgentArgvIdentity(update.argv);
        const cmd = typeof fresh.transport_agent_command === "string"
          ? fresh.transport_agent_command
          : undefined;
        if (cmd !== expectedIdentity) {
          result.skipped.push({
            alias: update.alias,
            agent: update.agent,
            reason: `fresh state: session "${update.alias}" recorded command changed (was "${expectedIdentity}", now "${cmd ?? "(unset)"}")`,
          });
          anyInvalid = true;
          continue;
        }
        const existingArgv = fresh.transport_agent_argv;
        if (Array.isArray(existingArgv) && existingArgv.length > 0) {
          const existingIdentity = renderAgentArgvIdentity(existingArgv as string[]);
          if (existingIdentity === expectedIdentity) {
            // Already migrated (concurrent run). Don't double-write; count
            // as a successful migration for the caller's reporting.
            result.migrated.push(update);
          } else {
            result.skipped.push({
              alias: update.alias,
              agent: update.agent,
              reason: `fresh state: session "${update.alias}" argv changed from target ${JSON.stringify(update.argv)} to ${JSON.stringify(existingArgv)}`,
            });
            anyInvalid = true;
          }
          continue;
        }
        validated.push(update);
      }
      if (anyInvalid) {
        pushError(result, deps.logger, "state.argv_migration.fresh_state_aborted",
          "fresh-state validation failed for one or more sessions; argv migration aborted (no writes applied)",
          { statePath: deps.statePath }, undefined);
        return;
      }

      // (2.5) Fresh per-agent safety recheck. The per-session validation
      // above only walked the planned aliases. If a new session for one
      // of the targeted agents was added between planning and lock
      // acquire, the planning-time per-agent invariant no longer holds.
      // Scan every fresh non-sticky session for each planned agent and
      // abort the whole transaction if any session has a different
      // identity OR has an unknown identity (no argv, no command).
      // This is the commit-time complement to the planning-time
      // per-agent check; uses the same `isDerivedAgentArgv` classification
      // as `resolveLaunchSpec` so the safety set is exact.
      let anyAgentUnsafe = false;
      for (const [agent, plannedArgv] of agentArgvByName) {
        const targetIdentity = renderAgentArgvIdentity(plannedArgv);
        for (const [freshAlias, freshSession] of Object.entries(freshSessions)) {
          if (!isRecord(freshSession)) continue;
          if (typeof freshSession.agent !== "string" || freshSession.agent !== agent) continue;
          const freshExistingArgv =
            Array.isArray(freshSession.transport_agent_argv) &&
            freshSession.transport_agent_argv.length > 0 &&
            freshSession.transport_agent_argv.every((e) => typeof e === "string")
              ? (freshSession.transport_agent_argv as string[])
              : undefined;
          const freshIsStickyByRecorded =
            typeof freshSession.transport_acpx_agent === "string" &&
            freshSession.transport_acpx_agent.length > 0 &&
            freshExistingArgv !== undefined;
          const freshIsSticky = freshIsStickyByRecorded && !isDerivedAgentArgv(
            agent,
            freshExistingArgv,
            runtimeRoot,
            platform,
          );
          if (freshIsSticky) continue;
          const freshCmd =
            typeof freshSession.transport_agent_command === "string"
              ? freshSession.transport_agent_command
              : undefined;
          const freshIdentity = freshExistingArgv
            ? renderAgentArgvIdentity(freshExistingArgv)
            : freshCmd ?? undefined;
          if (freshIdentity === undefined) {
            anyAgentUnsafe = true;
            result.skipped.push({
              alias: freshAlias,
              agent,
              reason: `fresh state: session "${freshAlias}" has no recorded identity; writing global argv would silently re-key it (cannot prove safety)`,
            });
            continue;
          }
          if (freshIdentity !== targetIdentity) {
            anyAgentUnsafe = true;
            result.skipped.push({
              alias: freshAlias,
              agent,
              reason: `fresh state: session "${freshAlias}" argv identity (${freshIdentity}) differs from planned agent "${agent}" argv identity (${targetIdentity}); writing global argv would silently re-key it`,
            });
          }
        }
      }
      if (anyAgentUnsafe) {
        pushError(result, deps.logger, "state.argv_migration.fresh_state_per_agent_aborted",
          "fresh state contains a session for a planned agent whose argv identity does not match the target; argv migration aborted (no writes applied)",
          { statePath: deps.statePath }, undefined);
        return;
      }

      // (3) Patch config. The mutator tracks three outcomes per agent:
      //   - written: we set argv on the agent (queued for result.configUpdates)
      //   - matched: argv was already present with the same identity (no-op)
      //   - conflicted: agent missing, raw command present, or argv identity
      //     mismatch - refuses to clobber user override and aborts state
      //     migration so we do not persist transport_agent_argv that
      //     points at an argv the config will not have.
      //
      // We commit to result.configUpdates only AFTER patchConfig resolves
      // successfully. The actual file write happens inside patchConfig
      // (ConfigStore.patchRaw holds its own config lock); if it throws,
      // the queued configUpdates is discarded and the error message
      // reflects that config may have been partially written.
      const configOutcome: { written: number; matched: number; conflicted: number } = {
        written: 0,
        matched: 0,
        conflicted: 0,
      };
      const queuedConfigUpdates: StateArgvMigrationConfigUpdate[] = [];
      if (agentArgvByName.size > 0) {
        try {
          await patchConfig((raw) => {
            const agents = ensureRecordAt(raw, "agents");
            for (const [name, argv] of agentArgvByName) {
              const existing = agents[name];
              if (!isRecord(existing)) {
                configOutcome.conflicted += 1;
                continue;
              }
              const driver = typeof existing.driver === "string" ? existing.driver : "";
              if (!driver) {
                configOutcome.conflicted += 1;
                continue;
              }
              if (Array.isArray(existing.argv) && existing.argv.length > 0) {
                const identity = renderAgentArgvIdentity(existing.argv);
                const targetIdentity = renderAgentArgvIdentity(argv);
                if (identity === targetIdentity) {
                  configOutcome.matched += 1;
                } else {
                  configOutcome.conflicted += 1;
                }
                continue;
              }
              if (typeof existing.command === "string" && existing.command.length > 0) {
                configOutcome.conflicted += 1;
                continue;
              }
              existing.argv = [...argv];
              queuedConfigUpdates.push({ agent: name, argv: [...argv] });
              configOutcome.written += 1;
            }
          });
          // patchConfig resolved without throwing: the config lock write
          // succeeded for every queued agent. Commit to result.
          for (const update of queuedConfigUpdates) {
            result.configUpdates.push(update);
          }
        } catch (error) {
          pushError(result, deps.logger, "state.argv_migration.config_patch_failed",
            "config.json patch failed; argv migration aborted (state was NOT written, config may have been partially written)",
            { configPath: deps.configPath }, error);
          return;
        }
        if (configOutcome.conflicted > 0) {
          pushError(result, deps.logger, "state.argv_migration.config_patch_conflicted",
            `config.json patch conflicted for ${configOutcome.conflicted} agent(s) (agent removed, raw command present, or argv identity mismatch); argv migration aborted (no state write)`,
            { configPath: deps.configPath }, undefined);
          return;
        }
      }

      // (4) Write state with the validated sessions. Preserve every other
      // top-level key from the fresh snapshot.
      const nextSessions: Record<string, unknown> = { ...freshSessions };
      for (const update of validated) {
        const fresh = nextSessions[update.alias];
        if (!isRecord(fresh)) continue; // defensive
        nextSessions[update.alias] = { ...fresh, transport_agent_argv: [...update.argv] };
        result.migrated.push(update);
      }
      const next: Record<string, unknown> = { ...freshParsed, sessions: nextSessions };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      await writeLocked(serialized);
    });
  } catch (error) {
    // The state lock acquire, fresh re-read, or final writeLocked threw
    // after the config patch had already been committed. By the time we
    // land here, config.json may have been written (and result.configUpdates
    // populated). State.json may be unchanged OR partially written —
    // `writePrivateFileAtomic` does temp+rename which is atomic on POSIX
    // and best-effort on Windows where the fallback direct write can
    // leave a partial file. State did NOT complete successfully; the
    // operator must verify both files, not assume "no writes applied".
    pushError(result, deps.logger, "state.argv_migration.write_failed",
      "argv migration failed during the state write step; state.json write did not complete successfully and may be unchanged or partially written; config.json may have been updated already and is now inconsistent with state.json",
      { statePath: deps.statePath }, error);
  }
}

return result;
}

/**
 * Per-agent all-or-nothing (Issue 1 v2 + v3): the safety bucket covers
 * Per-agent all-or-nothing (Issue 1 v2 + v3 + v4): the safety set
 * covers EVERY non-sticky session for the agent. The three-case rule
 * from the reviewer:
 *
 *   - sticky (per `isDerivedAgentArgv`-aware check; matches
 *     `resolveLaunchSpec` step 2)        => immune to config argv override
 *   - non-sticky + known identity == target => safe
 *   - non-sticky + known identity != target => abort (conflict)
 *   - non-sticky + unknown identity         => abort (cannot prove safety)
 *
 * A session has "unknown identity" when it has neither
 * `transport_agent_argv` nor `transport_agent_command`. Such a session
 * would currently resolve via `resolveLaunchSpec` step 5 (default
 * launch); writing `agents.<name>.argv` would change its behavior to
 * step 3 and is therefore unsafe.
 *
 * The function also requires unanimous known identity across the bucket
 * and at least one backfillable session to anchor argv.
 */
function aggregatePerAgent(
  plan: StateArgvMigrationPlanEntry[],
  result: StateArgvMigrationResult,
): {
  agentArgvByName: Map<string, string[]>;
  sessionUpdates: Array<{ alias: string; agent: string; argv: string[] }>;
} {
  const agentArgvByName = new Map<string, string[]>();
  const sessionUpdates: Array<{ alias: string; agent: string; argv: string[] }> = [];

  // Bucket every non-sticky session for the agent — including those
  // without a target identity. Unknown-identity sessions go in as a
  // sentinel: they are at risk and the safety check below aborts on
  // them when config argv would be written.
  const byAgent = new Map<string, StateArgvMigrationPlanEntry[]>();
  for (const entry of plan) {
    if (entry.isSticky) continue;
    const list = byAgent.get(entry.agent) ?? [];
    list.push(entry);
    byAgent.set(entry.agent, list);
  }

  for (const [agent, entries] of byAgent) {
    const knownIdentities = new Set(
      entries.filter((e) => e.argvIdentity !== undefined).map((e) => e.argvIdentity!),
    );
    const unknown = entries.filter((e) => e.argvIdentity === undefined);
    if (knownIdentities.size > 1) {
      const list = [...knownIdentities].join(", ");
      for (const e of entries) {
        result.skipped.push({
          alias: e.alias,
          agent,
          reason: `agent "${agent}" has ${knownIdentities.size} different argv identities (${list}); writing global argv would silently re-key the others`,
        });
      }
      continue;
    }
    // Single known identity (or none). Find a backfilled session to
    // anchor argv.
    const backfilled = entries.find(
      (e) => e.evaluation.status === "backfilled" && e.evaluation.targetArgv,
    );
    if (!backfilled) {
      const allNoop = entries.every((e) => e.evaluation.status === "noop");
      if (allNoop) {
        // Steady state — no writes needed.
        continue;
      }
      for (const e of entries) {
        result.skipped.push({
          alias: e.alias,
          agent,
          reason:
            e.evaluation.reason ??
            `cannot prove argv identity for agent "${agent}"`,
        });
      }
      continue;
    }
    if (unknown.length > 0) {
      // Unknown-identity sessions for this agent: cannot prove they
      // would not be silently re-keyed by the new config argv.
      // Abort the whole agent.
      for (const e of unknown) {
        result.skipped.push({
          alias: e.alias,
          agent,
          reason: `agent "${agent}" has session "${e.alias}" with no recorded identity; writing global argv would silently re-key it (cannot prove safety)`,
        });
      }
      continue;
    }
    // All non-sticky sessions for the agent agree on argv identity and
    // at least one is backfilled. Migrate every session in the bucket.
    const argv = [...backfilled.evaluation.targetArgv!];
    agentArgvByName.set(agent, argv);
    for (const e of entries) {
      sessionUpdates.push({ alias: e.alias, agent, argv: [...argv] });
    }
  }

  return { agentArgvByName, sessionUpdates };
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
  if (typeof command !== "string" || command.length === 0 || !/\s/.test(command)) return undefined;
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
    record = await readAcpxRecord(transportSession);
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
  // I/O failures (other than ENOENT for missing files) and JSON parse errors
  // are propagated to the caller as thrown exceptions so the migration can
  // surface them on stderr and exit non-zero. Returning null silently here
  // would hide the most likely cause of "cannot prove identity" — a corrupt
  // index or a permission error on a record file.
  const indexByName = new Map<string, string>();
  let indexLoaded = false;

  const loadIndex = async (): Promise<Map<string, string>> => {
    if (indexLoaded) return indexByName;
    const indexPath = join(sessionsDir, "index.json");
    let raw: string;
    try {
      raw = await readFile(indexPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        indexLoaded = true;
        return indexByName;
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
          indexByName.set(entry.name, entry.file);
        }
      }
    }
    indexLoaded = true;
    return indexByName;
  };

  return async (transportSession: string) => {
    const byName = await loadIndex();
    const file = byName.get(transportSession);
    if (!file) return null;
    const raw = await readFile(join(sessionsDir, file), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  };
}

async function defaultReadFile(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

function defaultPatchConfig(configPath: string) {
  return async (mutate: (raw: Record<string, unknown>) => void): Promise<void> => {
    const { ConfigStore } = await import("../config/config-store.js");
    const store = new ConfigStore(configPath);
    await store.patchRaw(mutate);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureRecordAt(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = raw[key];
  if (existing === undefined) {
    const created: Record<string, unknown> = {};
    raw[key] = created;
    return created;
  }
  if (!isRecord(existing)) {
    throw new Error(`refusing to overwrite config key "${key}": it is not a JSON object`);
  }
  return existing;
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