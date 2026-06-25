import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSessionListResult } from "./types";

/**
 * Hide Codex subagent threads from agent session lists.
 *
 * Codex's native `spawn_agent` tool runs subagents as their own threads. Those
 * threads show up in `acpx codex sessions list` alongside real user sessions
 * (they share the parent's cwd, so the cwd filter doesn't exclude them), and
 * acpx's list JSON only carries `{sessionId, cwd, title, updatedAt}` — it drops
 * the `parentThreadId`/source that would let us tell them apart. So there is no
 * signal in the list payload itself.
 *
 * The one place the distinction survives is Codex's own rollout store
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`): the first
 * `session_meta` line carries `payload.source`, which is an object shaped like
 * `{ subagent: { thread_spawn: { parent_thread_id, ... } } }` for subagents and
 * a bare string (`"unknown"`, `"vscode"`, …) for real sessions.
 *
 * This is a deliberate hack: Codex-specific, reaching into Codex's private
 * on-disk format. It is **fail-open** — any missing/unreadable/unparseable
 * rollout leaves the session visible — so a format change degrades to "shows a
 * phantom subagent session", never to "hides a real session". It is gated to
 * the Codex agent by callers; do not apply it to other agents.
 */

export const CODEX_AGENT_NAME = "codex";

/** Cap on bytes read while looking for a rollout's first line (session_meta). */
const FIRST_LINE_READ_CAP = 1024 * 1024;
const READ_CHUNK = 64 * 1024;
const ROLLOUT_RE = /rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/;

/** Resolve Codex's home dir: `$CODEX_HOME` if set, else `~/.codex`. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim();
  return fromEnv ? fromEnv : join(homedir(), ".codex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * True iff a Codex rollout `session_meta` `source` positively identifies a subagent
 * thread. A real subagent source is `{ subagent: { <variant>: { parent_thread_id: string, … } } }`
 * (the variant is `thread_spawn` for spawned subagents; review/compact/… are siblings).
 *
 * We require that full shape rather than just a `subagent` key, so format drift
 * (`{ subagent: null }`, `{ subagent: {} }`, `{ subagent: "x" }`) stays **fail-open**
 * (not recognized as a subagent → session kept visible).
 */
function isSubagentSource(source: unknown): boolean {
  if (!isPlainObject(source) || !Object.hasOwn(source, "subagent")) return false;
  const subagent = source.subagent;
  if (!isPlainObject(subagent)) return false;
  // Any variant object that carries a string parent_thread_id confirms a spawned subagent.
  return Object.values(subagent).some(
    (variant) => isPlainObject(variant) && typeof variant.parent_thread_id === "string",
  );
}

/**
 * True iff a rollout's first `session_meta` line marks it as a subagent thread.
 * Pure: returns false for undefined/malformed input or a non-subagent source.
 */
export function sessionMetaLineIsSubagent(line: string | undefined): boolean {
  if (!line) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  const payload = (parsed as { payload?: unknown })?.payload;
  return isSubagentSource((payload as { source?: unknown })?.source);
}

/** Reads rollout files; injectable so the predicate is unit-testable without a real FS. */
export interface RolloutReader {
  /** Absolute paths of every rollout file under the Codex home (recursive). */
  listRolloutPaths(): string[];
  /** First line of a rollout file, or undefined if it can't be read. */
  readFirstLine(path: string): string | undefined;
}

/**
 * Build a `sessionId → isSubagent` predicate from a {@link RolloutReader}. The
 * rollout index is built lazily on first use and results are memoized. Fail-open:
 * any error or unknown session resolves to `false` (treated as a real session).
 */
export function createSubagentPredicate(reader: RolloutReader): (sessionId: string) => boolean {
  let index: Map<string, string> | null = null;
  const cache = new Map<string, boolean>();
  return (sessionId: string): boolean => {
    const cached = cache.get(sessionId);
    if (cached !== undefined) return cached;
    let result = false;
    try {
      if (!index) {
        index = new Map();
        for (const path of reader.listRolloutPaths()) {
          const id = path.match(ROLLOUT_RE)?.[1];
          if (id) index.set(id.toLowerCase(), path);
        }
      }
      const path = index.get(sessionId.toLowerCase());
      if (path) result = sessionMetaLineIsSubagent(reader.readFirstLine(path));
    } catch {
      result = false; // fail-open
    }
    cache.set(sessionId, result);
    return result;
  };
}

/** Drop sessions the predicate positively flags as subagent threads. Fail-open per session. */
export function filterSubagentSessions(
  result: AgentSessionListResult,
  isSubagent: (sessionId: string) => boolean,
): AgentSessionListResult {
  return {
    ...result,
    sessions: result.sessions.filter((session) => {
      try {
        return !isSubagent(session.sessionId);
      } catch {
        return true; // fail-open: keep the session if detection throws
      }
    }),
  };
}

/** Node-fs-backed reader rooted at `<home>/sessions`. Errors degrade to empty/undefined. */
export function nodeRolloutReader(home: string): RolloutReader {
  const root = join(home, "sessions");
  return {
    listRolloutPaths() {
      const out: string[] = [];
      const walk = (dir: string): void => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) out.push(full);
        }
      };
      walk(root);
      return out;
    },
    readFirstLine(path) {
      let fd: number | undefined;
      try {
        // Guard against a pathological huge first line: read in chunks up to a cap.
        statSync(path);
        fd = openSync(path, "r");
        const buf = Buffer.alloc(READ_CHUNK);
        let acc = "";
        let total = 0;
        for (;;) {
          const bytes = readSync(fd, buf, 0, READ_CHUNK, total);
          if (bytes <= 0) break;
          acc += buf.toString("utf8", 0, bytes);
          total += bytes;
          const nl = acc.indexOf("\n");
          if (nl !== -1) return acc.slice(0, nl);
          if (total >= FIRST_LINE_READ_CAP) return undefined; // no newline within cap → fail-open
        }
        return acc.length ? acc : undefined; // single-line file with no trailing newline
      } catch {
        return undefined;
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    },
  };
}

/**
 * Convenience predicate used by the transports for the Codex agent. Reads the
 * real Codex rollout store under `resolveCodexHome()`.
 */
export function codexSubagentPredicate(env?: NodeJS.ProcessEnv): (sessionId: string) => boolean {
  return createSubagentPredicate(nodeRolloutReader(resolveCodexHome(env)));
}
