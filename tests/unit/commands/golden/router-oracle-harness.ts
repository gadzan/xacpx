import { CommandRouter } from "../../../../src/commands/command-router";
import { SessionService } from "../../../../src/sessions/session-service";
import { createEmptyState } from "../../../../src/state/types";
import type { AppLogger } from "../../../../src/logging/app-logger";
import type { SessionTransport, ResolvedSession } from "../../../../src/transport/types";
import type { SessionAgentCommandResolver } from "../../../../src/transport/acpx-session-index";
import type { OrchestrationRouterOps } from "../../../../src/commands/router-types";
import type { PerfSpan } from "../../../../src/perf/perf-tracer";
import { createConfig } from "../command-router-test-support";

// One ordered log across every collaborator the router touches. Call order = execution
// order (the router awaits each collaborator call in sequence). Time-varying fields are
// normalized so fixtures are deterministic.
function makeRecorder() {
  const record: string[] = [];
  const push = (line: string) => record.push(line);
  return { record, push };
}

// Strip nondeterminism (elapsed seconds, timestamps) from any string that lands in the
// ordered record. createProgressHandler embeds `elapsed`/`\d+s` into progress replies and
// session records carry ISO timestamps; scrub every possible time/second marker so fixtures
// are byte-identical across runs (control-service's oracle went flaky by skipping this).
function scrubText(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>")
    .replace(/\belapsed \d+/g, "elapsed <n>")
    .replace(/\b\d+s\b/g, "<n>s")
    // `/clear` builds a fresh transport session named `<ws>:<alias>:reset-<Date.now()>`
    // (session-reset-handler.buildResetTransportSessionName). The embedded epoch ms is
    // machine/run-varying and is NOT injectable from the harness (the ops factory hardcodes
    // `now: () => Date.now()`), so scrub it to keep the reset fixture byte-stable.
    .replace(/reset-\d+/g, "reset-<n>");
}

// Compact one arg into a stable, human-diffable token. Sessions/objects collapse to a
// short shape; long strings truncate; the volatile transportSession id is kept verbatim
// because it IS behaviourally load-bearing (dedup / reserve keying).
function summ(v: unknown): string {
  if (v === undefined) return "∅";
  if (v === null) return "null";
  if (typeof v === "string") {
    const scrubbed = scrubText(v);
    return scrubbed.length > 40 ? JSON.stringify(scrubbed.slice(0, 40) + "…") : JSON.stringify(scrubbed);
  }
  if (typeof v === "function") return "fn";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Scrub inside the session token too: the transportSession can embed a
    // `reset-<Date.now()>` suffix (from `/clear`), which would otherwise leak raw epoch ms here
    // even though string-arg rendering already scrubs it.
    if ("alias" in o && "transportSession" in o) return `session(${scrubText(String(o.alias))}/${scrubText(String(o.transportSession))})`;
    return "{…}";
  }
  return String(v);
}

// Wrap any collaborator so every method call appends `label.method(args)` before delegating
// to the real implementation (keeps behaviour real = faithful characterization).
function recordProxy<T extends object>(label: string, target: T, push: (l: string) => void): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const orig = Reflect.get(obj, prop, receiver);
      if (typeof orig !== "function" || typeof prop === "symbol") return orig;
      return (...args: unknown[]) => {
        push(`${label}.${String(prop)}(${args.map(summ).join(", ")})`);
        return (orig as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  });
}

// A logger whose levels append `logger.<level>(event)` (event name only — messages/fields
// are noise; the event name is the stable behavioural marker, esp. for best-effort catches).
function recordingLogger(push: (l: string) => void): AppLogger {
  const at = (lvl: string) => async (event: string) => push(`logger.${lvl}(${event})`);
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    cleanup: async () => {},
    flush: async () => {},
    child: () => recordingLogger(push),
  } as unknown as AppLogger;
}

// A PerfSpan whose `mark` appends `perfSpan.mark(<event>)` to the ordered record (event name
// only — the context object carries transportKind/localOutcome/decision noise and time-varying
// fields, so it is dropped; the event name is scrubbed like every other recorded token). Lets a
// scenario forward it into `handle(...)` to pin the spec's "perf 标记序" without leaking numbers.
// setOutcome is a no-op: nothing in the dispatch path records it, and it would only add noise.
function recordingPerfSpan(push: (l: string) => void): PerfSpan {
  return {
    traceId: "-",
    mark: (event: string) => push(`perfSpan.mark(${scrubText(event)})`),
    setOutcome: () => {},
  };
}

export interface RouterOracleScenario {
  name: string;
  // Seed the real SessionService before the run (attach existing sessions, mark archived…).
  seed?: (sessions: SessionService) => Promise<void>;
  // Optional transport-behaviour overrides (e.g. hasSession → false, resumeAgentSession absent).
  transport?: Partial<SessionTransport>;
  // Optional orchestration presence/behaviour override.
  orchestration?: Partial<OrchestrationRouterOps> | null;
  activeTurnsRunning?: boolean;
  // Optional deterministic agent-command resolver override. Defaults to a stub that returns
  // undefined so `refreshSessionTransportAgentCommand` is a machine-independent no-op (the
  // production default reads ~/.acpx/sessions/index.json off disk, which is nondeterministic
  // across machines/CI — the clean-baseline behaviour is "no cached command found").
  resolveSessionAgentCommand?: SessionAgentCommandResolver;
  // The action under test. Receives the router, a recording `reply`, and a recording
  // `perfSpan` (forward it into `handle(...)` to record the perf-mark sequence; scenarios that
  // ignore it record nothing extra, so existing fixtures stay byte-identical).
  run: (
    router: CommandRouter,
    reply: (t: string) => Promise<void>,
    perfSpan: PerfSpan,
  ) => Promise<unknown>;
}

export async function runRouterOracle(
  scenario: RouterOracleScenario,
): Promise<{ record: string[]; outcome: unknown }> {
  const { record, push } = makeRecorder();
  const config = createConfig();
  const baseTransport: SessionTransport = {
    ensureSession: async () => {},
    prompt: async (s: ResolvedSession, text: string) => ({ text: `agent:${s.alias}:${text}` }),
    setMode: async () => {},
    cancel: async () => ({ cancelled: true, message: "cancelled" }),
    hasSession: async () => true,
    tailSessionHistory: async () => ({ text: "" }),
    listAgentSessions: async () => ({ source: "agent" as const, sessions: [] }),
    resumeAgentSession: async () => {},
    deleteSession: async () => {},
    freeWarmProcess: async () => {},
    ...scenario.transport,
  };
  const sessions = new SessionService(config, { save: async () => {} } as never, createEmptyState());
  const recordedSessions = recordProxy("sessions", sessions, push);
  const recordedTransport = recordProxy("transport", baseTransport, push);
  await scenario.seed?.(sessions); // seed on the REAL instance (not the proxy) so setup isn't logged

  // Minimal orchestration fake (best-effort methods the CRUD paths hit). null = omit entirely.
  const orchestration =
    scenario.orchestration === null
      ? undefined
      : recordProxy(
          "orchestration",
          {
            listSessionBlockingTasks: async () => [],
            purgeSessionReferences: async () => {},
            reserveLogicalTransportSession: async () => async () => {},
            ...scenario.orchestration,
          } as OrchestrationRouterOps,
          push,
        );

  const activeTurns = { isActiveAnywhere: () => scenario.activeTurnsRunning ?? false } as never;
  const resolver: SessionAgentCommandResolver =
    scenario.resolveSessionAgentCommand ?? (async () => undefined);
  const router = new CommandRouter(
    recordedSessions as unknown as SessionService,
    recordedTransport,
    config,
    undefined,
    recordingLogger(push),
    resolver,
    orchestration,
    undefined,
    undefined,
    undefined,
    undefined,
    activeTurns,
  );
  const reply = async (t: string) => {
    push(`reply(${summ(t)})`);
  };
  const perfSpan = recordingPerfSpan(push);
  let outcome: unknown;
  try {
    outcome = { ok: await scenario.run(router, reply, perfSpan) };
  } catch (err) {
    outcome = { threw: err instanceof Error ? err.message : String(err) };
  }
  return { record, outcome: normalize(outcome) };
}

// Strip nondeterminism from the returned value (timestamps, generated ids the fixture
// shouldn't pin). Records themselves already avoid time via recordingLogger/summ.
function normalize(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, val) =>
      typeof val === "string" ? val.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>") : val,
    ),
  );
}
