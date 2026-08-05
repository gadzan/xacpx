import { expect, test } from "bun:test";

import { MSG, RECOVERY_RETENTION_MS, STATE_SYNC_PARTS_CAP, STATE_SYNC_TEXT_CAP, validInstanceStateSync } from "../../../../packages/relay-protocol/src/index";
import type { ControlEventDto, ToolStepDto } from "../../../../packages/relay-protocol/src/index";
import { createStateMirror, type StateMirror } from "../../../../packages/channel-relay/src/state-mirror";

const LIVE = new Set(["backend", "frontend"]);

function step(id: string): ToolStepDto {
  return { toolCallId: id, toolName: "Bash", kind: "execute", status: "success", title: `run ${id}` };
}

/** Fire one control event at the mirror the same way channel.ts forwards it. */
function fire(mirror: StateMirror, event: ControlEventDto): void {
  mirror.handleEnvelope(MSG.instanceEvent, { event });
}

function makeMirror(ready: () => boolean, now?: () => number) {
  const warns: Array<{ event: string }> = [];
  let nextId = 1;
  const mirror = createStateMirror({
    isReady: ready,
    recoveryId: () => `r${nextId++}`,
    logger: { warn: async (event: string) => { warns.push({ event }); } },
    ...(now ? { now } : {}),
  });
  return { mirror, warns };
}

test("accumulates a turn across event kinds and builds a valid sync payload", () => {
  const { mirror } = makeMirror(() => true, () => 1_700_000_000_000);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend", prompt: "hi" });
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "hel" });
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "lo" });
  fire(mirror, { type: "turn-thought", chatKey: "relay:acc", sessionAlias: "backend", chunk: "thinking" });
  fire(mirror, { type: "tool-event", chatKey: "relay:acc", sessionAlias: "backend", step: step("t1") });
  fire(mirror, { type: "turn-usage", chatKey: "relay:acc", sessionAlias: "backend", used: 10, size: 100 });
  fire(mirror, { type: "agent-commands", chatKey: "relay:acc", sessionAlias: "backend", commands: [{ name: "compact" }] });

  const { snapshot: payload } = mirror.buildStateSync(LIVE);
  expect(payload.turns).toEqual([{
    sessionAlias: "backend", startedAt: 1_700_000_000_000, text: "hello", reasoning: "thinking",
    steps: [step("t1")], parts: [
      { type: "text", text: "hello" },
      { type: "reasoning", text: "thinking" },
      { type: "tool", step: step("t1") },
    ], prompt: "hi", recoveryId: "r1",
  }]);
  expect(payload.usage).toEqual([{ sessionAlias: "backend", used: 10, size: 100 }]);
  expect(payload.commands).toEqual([{ sessionAlias: "backend", commands: [{ name: "compact" }] }]);
  expect(payload.finishedOffline).toEqual([]);
  expect(validInstanceStateSync(payload)).toBe(true);
});

test("text cap truncates and stops appending", () => {
  const { mirror } = makeMirror(() => true);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "x".repeat(STATE_SYNC_TEXT_CAP + 10) });
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "more" });
  const turn = mirror.buildStateSync(LIVE).snapshot.turns[0]!;
  expect(turn.text.length).toBe(STATE_SYNC_TEXT_CAP);
  expect(turn.truncated).toBe(true);
});

test("tool steps cap at 200; updates to known toolCallIds always merge", () => {
  const { mirror } = makeMirror(() => true);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  for (let i = 0; i < 210; i++) {
    fire(mirror, { type: "tool-event", chatKey: "relay:acc", sessionAlias: "backend", step: step(`t${i}`) });
  }
  fire(mirror, { type: "tool-event", chatKey: "relay:acc", sessionAlias: "backend", step: { ...step("t0"), status: "error", error: "boom" } });
  const turn = mirror.buildStateSync(LIVE).snapshot.turns[0]!;
  expect(turn.steps).toHaveLength(200);
  expect(turn.steps.find((s) => s.toolCallId === "t0")).toMatchObject({ status: "error" });
});

test("reasoning caps at 16000 chars", () => {
  const { mirror } = makeMirror(() => true);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  fire(mirror, { type: "turn-thought", chatKey: "relay:acc", sessionAlias: "backend", chunk: "r".repeat(20000) });
  expect(mirror.buildStateSync(LIVE).snapshot.turns[0]!.reasoning.length).toBe(16000);
});

test("ordered recovery parts remain bounded", () => {
  const { mirror } = makeMirror(() => true);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  for (let i = 0; i < STATE_SYNC_PARTS_CAP + 20; i++) {
    fire(mirror, i % 2 === 0
      ? { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "x" }
      : { type: "turn-thought", chatKey: "relay:acc", sessionAlias: "backend", chunk: "r" });
  }
  const turn = mirror.buildStateSync(LIVE).snapshot.turns[0]!;
  expect(turn.parts).toHaveLength(STATE_SYNC_PARTS_CAP);
  expect(validInstanceStateSync({ turns: [{ ...turn, parts: [...turn.parts!, { type: "text", text: "overflow" }] }], usage: [], commands: [], finishedOffline: [] })).toBe(false);
});

test("turn-finished stays recoverable until its send is confirmed", () => {
  const { mirror } = makeMirror(() => true);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "done" });
  fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: "backend", ok: true });
  const { snapshot: payload } = mirror.buildStateSync(LIVE);
  expect(payload.turns).toEqual([]);
  expect(payload.finishedOffline).toEqual([{ sessionAlias: "backend", ok: true, text: "done", recoveryId: "r1" }]);
  mirror.confirmFinished(["r1"]);
  expect(mirror.buildStateSync(LIVE).snapshot.finishedOffline).toEqual([]);
});

test("turn-finished while offline queues the turn with its accumulated text", () => {
  const { mirror } = makeMirror(() => false);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "reply text" });
  fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: "backend", ok: true });
  const { snapshot: payload } = mirror.buildStateSync(LIVE);
  expect(payload.finishedOffline).toEqual([{ sessionAlias: "backend", ok: true, text: "reply text", recoveryId: "r1" }]);
  mirror.confirmFinished(["r1"]);
  expect(mirror.buildStateSync(LIVE).snapshot.finishedOffline).toEqual([]);
});

test("turn-finished while offline carries the turn's prompt for hub-side backfill", () => {
  const { mirror } = makeMirror(() => false);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend", prompt: "deploy it" });
  fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: "backend", ok: true });
  const { snapshot: payload } = mirror.buildStateSync(LIVE);
  expect(payload.finishedOffline[0]).toMatchObject({ sessionAlias: "backend", prompt: "deploy it" });
  expect(validInstanceStateSync(payload)).toBe(true);
});

test("a queued turn carries its queueItemId so the hub reconciles the queued row", () => {
  const { mirror } = makeMirror(() => false);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend", prompt: "deploy it", queueItemId: "q1" });
  fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: "backend", ok: true });
  const { snapshot: payload } = mirror.buildStateSync(LIVE);
  expect(payload.finishedOffline[0]).toMatchObject({ sessionAlias: "backend", queueItemId: "q1", prompt: "deploy it" });
  expect(validInstanceStateSync(payload)).toBe(true);
});

test("turn-finished while offline without an accumulator still carries the event text", () => {
  const { mirror } = makeMirror(() => false);
  fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: "backend", ok: false, errorMessage: "kaboom" });
  expect(mirror.buildStateSync(LIVE).snapshot.finishedOffline).toEqual([
    { sessionAlias: "backend", ok: false, errorMessage: "kaboom", recoveryId: "r1" },
  ]);
});

test("failed turn with an empty accumulator ships its errorMessage, not an empty text", () => {
  const { mirror } = makeMirror(() => false);
  // Accumulator exists (turn ran) but produced no output: `text` stays "". The
  // entry must NOT carry text:"" — that would overwrite the error text on the hub
  // and leave an empty reply where the failure story belongs.
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend", prompt: "deploy" });
  fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: "backend", ok: false, errorMessage: "boom" });
  expect(mirror.buildStateSync(LIVE).snapshot.finishedOffline).toEqual([
    { sessionAlias: "backend", ok: false, errorMessage: "boom", prompt: "deploy", recoveryId: "r1" },
  ]);
  // A successful turn with no output still ships its (empty) reply — presence semantics.
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "frontend" });
  fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: "frontend", ok: true });
  expect(mirror.buildStateSync(LIVE).snapshot.finishedOffline).toEqual([
    { sessionAlias: "backend", ok: false, errorMessage: "boom", prompt: "deploy", recoveryId: "r1" },
    { sessionAlias: "frontend", ok: true, text: "", recoveryId: "r2" },
  ]);
});

test("a truncated reply rides the finishedOffline entry so the hub can mark it", () => {
  const { mirror } = makeMirror(() => false);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "x".repeat(STATE_SYNC_TEXT_CAP + 10) });
  fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: "backend", ok: true });
  const entry = mirror.buildStateSync(LIVE).snapshot.finishedOffline[0]!;
  expect(entry.truncated).toBe(true);
  expect(entry.text!.length).toBe(STATE_SYNC_TEXT_CAP);
  expect(validInstanceStateSync({ turns: [], usage: [], commands: [], finishedOffline: [entry] })).toBe(true);
});

test("finishedOffline is a FIFO capped at 32 with a logged warning on eviction", () => {
  const { mirror, warns } = makeMirror(() => false);
  for (let i = 0; i < 33; i++) {
    const alias = `s${i}`;
    fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: alias });
    fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: alias, chunk: `out${i}` });
    fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: alias, ok: true });
  }
  const { snapshot: payload } = mirror.buildStateSync(new Set(Array.from({ length: 33 }, (_, i) => `s${i}`)));
  expect(payload.finishedOffline).toHaveLength(32);
  expect(payload.finishedOffline[0]!.sessionAlias).toBe("s1"); // oldest evicted
  expect(payload.finishedOffline[31]!.sessionAlias).toBe("s32");
  expect(warns.some((l) => l.event === "relay.state_mirror.pending_finished_evicted")).toBe(true);
});

test("a truncated flip exactly at the cap still bumps the alias generation", () => {
  const { mirror } = makeMirror(() => false);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  // The accumulator reaches the cap EXACTLY — not yet truncated.
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "x".repeat(STATE_SYNC_TEXT_CAP) });
  expect(mirror.buildStateSync(LIVE).snapshot.turns[0]!.truncated).toBeUndefined();
  // Snapshot while the turn is still untruncated.
  const { aliases } = mirror.buildStateSync(new Set([]));
  // A chunk arriving exactly at the cap flips truncated false → true with accepted ===
  // "" — the generation must reflect the change, or the older prune callback would
  // consider the alias unchanged and delete it.
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "more" });
  mirror.pruneStateMirror(new Set([]), aliases);
  const after = mirror.buildStateSync(new Set(["backend"]));
  expect(after.snapshot.turns).toHaveLength(1);
  expect(after.snapshot.turns[0]!.truncated).toBe(true);
});

test("pendingFinished entries expire past the shared retention horizon", () => {
  let t = 1_700_000_000_000;
  const { mirror, warns } = makeMirror(() => false, () => t);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: "backend", ok: true });
  expect(mirror.buildStateSync(LIVE).snapshot.finishedOffline).toHaveLength(1);

  // Past RECOVERY_RETENTION_MS the entry is dropped: the hub prunes its receipt on
  // the same horizon, so re-delivering this entry after a long idle would re-append
  // a duplicate reply.
  t += RECOVERY_RETENTION_MS + 1;
  mirror.expirePendingFinished();
  expect(mirror.buildStateSync(LIVE).snapshot.finishedOffline).toEqual([]);
  expect(warns.some((l) => l.event === "relay.state_mirror.pending_finished_expired")).toBe(true);
});

test("buildStateSync filters dead aliases without mutating; pruneStateMirror removes only build-time aliases", () => {
  const { mirror } = makeMirror(() => false);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "frontend" });
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "frontend", chunk: "x" });
  fire(mirror, { type: "turn-usage", chatKey: "relay:acc", sessionAlias: "frontend", used: 1, size: 2 });
  fire(mirror, { type: "agent-commands", chatKey: "relay:acc", sessionAlias: "frontend", commands: [{ name: "c" }] });
  fire(mirror, { type: "turn-finished", chatKey: "relay:acc", sessionAlias: "frontend", ok: true });

  // buildStateSync is a pure copy: the payload excludes dead aliases, but the
  // mirror keeps them — a failed/not-ready send must not destroy state that a
  // later sync (with a corrected session list) could still need.
  const filtered = mirror.buildStateSync(new Set(["backend"]));
  expect(filtered.snapshot.turns.map((t) => t.sessionAlias)).toEqual(["backend"]);
  expect(filtered.snapshot.usage).toEqual([]);
  expect(filtered.snapshot.commands).toEqual([]);
  expect(filtered.snapshot.finishedOffline).toEqual([]);
  expect([...filtered.aliases.keys()].sort()).toEqual(["backend", "frontend"]);
  const widened = mirror.buildStateSync(LIVE);
  expect(widened.snapshot.turns.map((t) => t.sessionAlias)).toEqual(["backend"]);
  expect(widened.snapshot.usage).toHaveLength(1);
  expect(widened.snapshot.finishedOffline.map((f) => f.sessionAlias)).toEqual(["frontend"]); // finished → pending, still in LIVE

  // The explicit GC (called after a CONFIRMED flush) removes dead aliases — but only
  // the ones that existed when the snapshot was built.
  const { snapshot, aliases } = mirror.buildStateSync(LIVE);
  expect(snapshot.turns).toHaveLength(1);
  mirror.pruneStateMirror(new Set(["backend"]), aliases);
  const again = mirror.buildStateSync(LIVE);
  expect(again.snapshot.turns.map((t) => t.sessionAlias)).toEqual(["backend"]);
  expect(again.snapshot.usage).toEqual([]);
  expect(again.snapshot.commands).toEqual([]);
  expect(again.snapshot.finishedOffline).toEqual([]);
});

test("pruneStateMirror never removes state that arrived after the snapshot was built", () => {
  const { mirror } = makeMirror(() => false);
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  // The snapshot is built while only `backend` exists…
  const { aliases } = mirror.buildStateSync(new Set(["backend"]));
  // …then a NEW session's turn arrives (forwarded live) before the flush callback
  // runs. The (older) prune must not GC it.
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "latecomer" });
  mirror.pruneStateMirror(new Set(["backend"]), aliases);
  const after = mirror.buildStateSync(new Set(["backend", "latecomer"]));
  expect(after.snapshot.turns.map((t) => t.sessionAlias)).toEqual(["backend", "latecomer"]);
});

test("pruneStateMirror never removes a SAME alias that was re-created after the snapshot", () => {
  const { mirror } = makeMirror(() => false);
  // The snapshot is built with `backend` absent from the live list (it "died"
  // offline) — the old prune would GC it…
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  const { aliases } = mirror.buildStateSync(new Set([]));
  // …but before the flush callback runs, `backend` is re-created and starts a NEW
  // turn (same alias, newer generation). The older prune must not delete it.
  fire(mirror, { type: "turn-started", chatKey: "relay:acc", sessionAlias: "backend" });
  fire(mirror, { type: "turn-output", chatKey: "relay:acc", sessionAlias: "backend", chunk: "new gen" });
  mirror.pruneStateMirror(new Set([]), aliases);
  const after = mirror.buildStateSync(new Set(["backend"]));
  expect(after.snapshot.turns).toHaveLength(1);
  expect(after.snapshot.turns[0]!.text).toBe("new gen");
  // And a later prune with the NEW generation (unchanged since) does GC a dead alias.
  const { aliases: aliases2 } = mirror.buildStateSync(new Set([]));
  mirror.pruneStateMirror(new Set([]), aliases2);
  expect(mirror.buildStateSync(new Set(["backend"])).snapshot.turns).toEqual([]);
});

test("chatKeys and aliasesForChatKey group mirrored state by chatKey", () => {
  const { mirror } = makeMirror(() => true);
  fire(mirror, { type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  fire(mirror, { type: "turn-usage", chatKey: "relay:a2", sessionAlias: "other", used: 1, size: 2 });
  expect(new Set(mirror.chatKeys())).toEqual(new Set(["relay:a1", "relay:a2"]));
  expect(mirror.aliasesForChatKey("relay:a1")).toEqual(["backend"]);
  expect(mirror.aliasesForChatKey("unknown")).toEqual([]);
});

test("ignores non-instanceEvent envelopes and malformed payloads", () => {
  const { mirror } = makeMirror(() => true);
  mirror.handleEnvelope(MSG.instanceNotice, { kind: "task-progress", text: "x" });
  mirror.handleEnvelope(MSG.instanceEvent, null);
  mirror.handleEnvelope(MSG.instanceEvent, {});
  expect(mirror.buildStateSync(LIVE).snapshot).toEqual({ turns: [], usage: [], commands: [], finishedOffline: [] });
});
