// tests/unit/control/golden/turn-oracle-harness.ts
// Black-box characterization oracle for ControlService's turn machinery. Records, in
// order, every event ControlService emits AND every entry-call return value across a
// scenario. `deps.events.emit` is synchronous, so the log order IS the execution order
// (across microtasks) — that is how this catches a same-tick timing regression that a
// plain result assertion cannot see. Drives ControlService's PUBLIC surface only; never
// inspects the private inFlight/queues/draining maps.
//
// Recorded values are STABILIZED before they enter the log: a queued item's id is a
// randomUUID and its enqueuedAt is wall-clock time, so without this the fixtures would be
// flaky (a fresh id/timestamp every run). `stabilize` maps each distinct UUID to `<id-N>`
// in first-seen order and every ISO timestamp to `<ts>`, which keeps the fixtures
// deterministic while preserving order, structure, and — crucially — which prompt won
// (the winner's return is {ok}, the loser's is {queued}; those are not ids or timestamps).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect } from "bun:test";
import { createControlEventBus, type ControlEvent } from "../../../../src/control/control-event-bus";
import { ControlService } from "../../../../src/control/control-service";
import type { ChatRequest, ChatResponse } from "../../../../src/weixin/agent/interface";

export type OracleEntry =
  | { kind: "event"; event: unknown }
  | { kind: "return"; label: string; value: unknown };

interface PendingChat {
  request: ChatRequest;
  resolve: (r: ChatResponse) => void;
  reject: (e: unknown) => void;
}

export function makeTurnOracle(opts?: {
  useSession?: (chatKey: string, alias: string) => Promise<unknown>;
  getSession?: (alias: string) => Promise<unknown>;
}) {
  const log: OracleEntry[] = [];
  const stabilizer = makeStabilizer();
  const events = createControlEventBus();
  events.subscribe((event: ControlEvent) => log.push({ kind: "event", event: stabilizer(event) }));

  const pending: PendingChat[] = [];
  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    // A scenario resolves each chat explicitly via controls (FIFO), so the recording is
    // deterministic — no setTimeout races, no wall-clock ordering.
    return await new Promise<ChatResponse>((resolve, reject) => {
      pending.push({ request, resolve, reject });
    });
  };

  const service = new ControlService({
    agent: { chat },
    sessions: {
      listAllResolvedSessions: () => [],
      useSession:
        opts?.useSession ??
        (async (_c: string, alias: string) => ({ alias, agent: "claude", workspace: "/ws" })),
      resolveAliasForChat: async (_c: string, alias: string) => alias,
      getSession: opts?.getSession ?? (async () => null),
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
    uploadStore: { root: "/tmp/uploads" },
  } as never);

  const record = async <T>(label: string, p: Promise<T>): Promise<T> => {
    const value = await p;
    log.push({ kind: "return", label, value: stabilizer(value) });
    return value;
  };

  return {
    service,
    log,
    record,
    controls: {
      resolveChat: (index = 0, text = "done") => pending.splice(index, 1)[0]?.resolve({ text }),
      rejectChat: (index = 0, message = "boom") =>
        pending.splice(index, 1)[0]?.reject(new Error(message)),
      pendingCount: () => pending.length,
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Returns a stabilizer that deep-clones a value and replaces non-deterministic scalars.
 *  UUIDs → `<id-N>` (stable in first-seen order); ISO timestamps → `<ts>`. Note the JSON
 *  round-trip drops `undefined`-valued fields — fine here: the real StateStore/wire also
 *  JSON-serializes, so a fixture never carries `undefined` keys. */
function makeStabilizer() {
  const ids = new Map<string, string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (UUID_RE.test(v)) {
        let mapped = ids.get(v);
        if (mapped === undefined) {
          mapped = `<id-${ids.size + 1}>`;
          ids.set(v, mapped);
        }
        return mapped;
      }
      if (ISO_RE.test(v)) return "<ts>";
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return (v: unknown): unknown => walk(JSON.parse(JSON.stringify(v ?? null)));
}

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url).pathname;

export function expectMatchesFixture(name: string, actual: unknown): void {
  const path = `${FIXTURE_DIR}${name}.json`;
  const serialized = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.GOLDEN_UPDATE === "1") {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path, serialized);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(`turn oracle fixture missing: ${name}.json — record with GOLDEN_UPDATE=1 on the baseline`);
  }
  expect(JSON.parse(serialized) as unknown).toEqual(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
