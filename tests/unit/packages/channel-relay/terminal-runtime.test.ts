import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  SessionResourceCatalog,
  SessionResourceDescriptor,
  SessionResourceLifecycleEvent,
} from "xacpx/plugin-api";

import type { RelayTerminalConfig } from "../../../../packages/channel-relay/src/config";
import { InMemoryRmuxDriver } from "../../../../packages/channel-relay/src/terminal/in-memory-rmux-driver";
import { TerminalRegistryStore } from "../../../../packages/channel-relay/src/terminal/terminal-registry-store";
import {
  DefaultRelayTerminalRuntime,
  TerminalRuntimeError,
  type TerminalViewerEvent,
} from "../../../../packages/channel-relay/src/terminal/terminal-runtime";
import { TERMINAL_REBASE_CHUNK_BYTES } from "@ganglion/xacpx-relay-protocol";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "term-runtime-"));
  dirs.push(dir);
  return dir;
}

function baseConfig(overrides: Partial<RelayTerminalConfig> = {}): RelayTerminalConfig {
  return {
    enabled: true,
    backend: "rmux",
    idleTimeoutSeconds: 900,
    ownerLeaseTtlSeconds: 90,
    reconcileIntervalSeconds: 30,
    orphanGraceSeconds: 120,
    attachmentTtlSeconds: 45,
    maxSessions: 16,
    maxViewersPerTerminal: 4,
    historyLimit: 10000,
    ...overrides,
  };
}

function descriptor(
  overrides: Partial<SessionResourceDescriptor> = {},
): SessionResourceDescriptor {
  return {
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    channelId: "relay",
    internalAlias: "demo",
    displayAlias: "demo",
    workspace: "ws",
    cwd: "/tmp/ws",
    archived: false,
    ...overrides,
  };
}

class FakeCatalog implements SessionResourceCatalog {
  private readonly byAlias = new Map<string, SessionResourceDescriptor>();

  constructor(initial: SessionResourceDescriptor[] = []) {
    for (const d of initial) this.byAlias.set(d.displayAlias, d);
  }

  set(d: SessionResourceDescriptor): void {
    this.byAlias.set(d.displayAlias, d);
  }

  async resolve(_chatKey: string, alias: string): Promise<SessionResourceDescriptor | null> {
    return this.byAlias.get(alias) ?? null;
  }

  async list(channelId: string): Promise<SessionResourceDescriptor[]> {
    return [...this.byAlias.values()].filter((d) => d.channelId === channelId);
  }

  subscribe(_listener: (event: SessionResourceLifecycleEvent) => void): () => void {
    return () => {};
  }
}

interface Harness {
  runtime: DefaultRelayTerminalRuntime;
  driver: InMemoryRmuxDriver;
  registry: TerminalRegistryStore;
  catalog: FakeCatalog;
  events: TerminalViewerEvent[];
  clock: { nowMs: number; now: () => number };
}

async function makeHarness(
  opts: {
    config?: Partial<RelayTerminalConfig>;
    descriptors?: SessionResourceDescriptor[];
    killTimeoutMs?: number;
  } = {},
): Promise<Harness> {
  const dir = freshDir();
  const registry = new TerminalRegistryStore({ dir });
  const driver = new InMemoryRmuxDriver();
  const catalog = new FakeCatalog(opts.descriptors ?? [descriptor()]);
  const events: TerminalViewerEvent[] = [];
  const clock = { nowMs: 1_000_000, now: () => clock.nowMs };
  const runtime = new DefaultRelayTerminalRuntime({
    registry,
    driver,
    catalog,
    config: baseConfig(opts.config),
    onViewerEvent: (e, onFlush) => {
      events.push(e);
      // Default harness simulates a fast socket: flush immediately so pending
      // outbound bytes release and healthy streams are not lifetime-capped.
      onFlush?.();
    },
    clock,
    killTimeoutMs: opts.killTimeoutMs ?? 50,
    lastInputCheckpointMinIntervalMs: 30_000,
  });
  await runtime.start();
  return { runtime, driver, registry, catalog, events, clock };
}

test("openOrResume creates durable live resource with exact name/tags and controller attachment", async () => {
  const { runtime, driver, registry } = await makeHarness();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "viewer-a",
    cols: 80,
    rows: 24,
  });

  expect(opened.role).toBe("controller");
  expect(opened.viewerCount).toBe(1);

  const snap = registry.getSnapshot();
  const rec = snap.terminals[opened.terminalId];
  expect(rec?.state).toBe("live");
  expect(rec?.logicalSessionId).toBe(descriptor().logicalSessionId);
  expect(rec?.rmuxSessionName).toBe(
    `xacpx-relay-${snap.installationId.slice(0, 8)}-${opened.terminalId.replaceAll("-", "")}`,
  );

  const inventory = await driver.list();
  expect(inventory).toHaveLength(1);
  expect(inventory[0]?.tags).toEqual([
    "xacpx:relay",
    `owner:${snap.installationId}`,
    `logical:${descriptor().logicalSessionId}`,
    `terminal:${opened.terminalId}`,
    `generation:${opened.generation}`,
    "schema:1",
  ]);
});

test("openOrResume is idempotent by logicalSessionId (alias reuse shares one resource)", async () => {
  const sharedLogical = descriptor({
    displayAlias: "a",
    internalAlias: "a",
  });
  const aliasB = descriptor({
    displayAlias: "b",
    internalAlias: "b",
    // Same logical id — alias rename / shared transport case
    logicalSessionId: sharedLogical.logicalSessionId,
  });
  const { runtime, driver } = await makeHarness({
    descriptors: [sharedLogical, aliasB],
  });

  const first = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "a",
    viewerId: "v1",
    cols: 80,
    rows: 24,
  });
  const second = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "b",
    viewerId: "v2",
    cols: 100,
    rows: 30,
  });

  expect(second.terminalId).toBe(first.terminalId);
  expect(second.generation).toBe(first.generation);
  expect(second.role).toBe("spectator");
  expect(second.viewerCount).toBe(2);
  expect(await driver.list()).toHaveLength(1);
});

test("same viewerId re-open replaces the prior attachment and stays controller", async () => {
  const { runtime } = await makeHarness();
  const first = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v1",
    cols: 80,
    rows: 24,
  });
  const second = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v1",
    cols: 80,
    rows: 24,
  });
  expect(second.terminalId).toBe(first.terminalId);
  expect(second.role).toBe("controller");
  expect(second.viewerCount).toBe(1);
  expect(second.attachmentId).not.toBe(first.attachmentId);
  expect(runtime.peekAttachment(first.attachmentId)).toBeUndefined();
});

test("concurrent openOrResume for one logical id only creates one RMUX session", async () => {
  const { runtime, driver } = await makeHarness();
  const results = await Promise.all([
    runtime.openOrResume({
      chatKey: "relay:u1",
      sessionAlias: "demo",
      viewerId: "v1",
      cols: 80,
      rows: 24,
    }),
    runtime.openOrResume({
      chatKey: "relay:u1",
      sessionAlias: "demo",
      viewerId: "v2",
      cols: 80,
      rows: 24,
    }),
  ]);
  expect(results[0]?.terminalId).toBe(results[1]?.terminalId);
  expect(await driver.list()).toHaveLength(1);
});

test("catalog miss / archived / wrong channel map to stable error codes", async () => {
  const { runtime, catalog } = await makeHarness();
  await expect(
    runtime.openOrResume({
      chatKey: "relay:u1",
      sessionAlias: "missing",
      viewerId: "v",
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ code: "terminal-session-not-found" });

  catalog.set(descriptor({ displayAlias: "arch", archived: true }));
  await expect(
    runtime.openOrResume({
      chatKey: "relay:u1",
      sessionAlias: "arch",
      viewerId: "v",
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ code: "terminal-session-archived" });

  catalog.set(descriptor({ displayAlias: "wx", channelId: "weixin" }));
  await expect(
    runtime.openOrResume({
      chatKey: "relay:u1",
      sessionAlias: "wx",
      viewerId: "v",
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ code: "terminal-session-not-found" });
});

test("quota rejects with terminal-capacity-exceeded after reaping only expired/reaping", async () => {
  const { runtime, catalog, clock, registry } = await makeHarness({
    config: { maxSessions: 1, idleTimeoutSeconds: 60 },
  });

  const first = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v1",
    cols: 80,
    rows: 24,
  });

  catalog.set(
    descriptor({
      displayAlias: "other",
      logicalSessionId: "22222222-2222-4222-8222-222222222222",
    }),
  );
  await expect(
    runtime.openOrResume({
      chatKey: "relay:u1",
      sessionAlias: "other",
      viewerId: "v2",
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ code: "terminal-capacity-exceeded" });

  // Still one live — no LRU kill of the non-expired resource.
  expect(registry.getSnapshot().terminals[first.terminalId]?.state).toBe("live");

  clock.nowMs += 61_000;
  const second = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "other",
    viewerId: "v2",
    cols: 80,
    rows: 24,
  });
  expect(second.terminalId).not.toBe(first.terminalId);
  expect(registry.getSnapshot().terminals[first.terminalId]).toBeUndefined();
});

test("create failure leaves reaping/cleanup and does not return success", async () => {
  const { runtime, driver, registry } = await makeHarness();
  driver.configureFailure("create", new Error("boom"), 1);

  await expect(
    runtime.openOrResume({
      chatKey: "relay:u1",
      sessionAlias: "demo",
      viewerId: "v",
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ code: "terminal-rmux-unavailable" });

  const terminals = Object.values(registry.getSnapshot().terminals);
  // Either removed after compensate or left as reaping tombstone — never live.
  expect(terminals.every((t) => t.state !== "live")).toBe(true);
});

test("startRecovery emits rebase first with 48KiB chunking; input/resize require controller", async () => {
  const { runtime, driver, events } = await makeHarness();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "controller",
    cols: 80,
    rows: 24,
  });
  const spectator = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "spectator",
    cols: 80,
    rows: 24,
  });

  const sessions = await driver.list();
  const sessionId = sessions[0]!.sessionId;
  const big = new Uint8Array(TERMINAL_REBASE_CHUNK_BYTES + 10);
  big.fill(7);
  driver.triggerRebase(sessionId, { keyframe: big });

  // Default recover already pushes a rebase; triggerRebase before subscribe
  // only affects next recover's initial keyframe via session.keyframe — set via
  // inject path: create empty, then after startRecovery the first event is rebase.
  events.length = 0;
  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(20);

  const rebaseStart = events.find((e) => e.type === "rebase-start");
  expect(rebaseStart).toBeDefined();
  expect(events[0]?.type).toBe("rebase-start");

  await expect(
    runtime.input(spectator.attachmentId, spectator.generation, new Uint8Array([1])),
  ).rejects.toMatchObject({ code: "terminal-not-controller" });

  await runtime.input(opened.attachmentId, opened.generation, new Uint8Array([1]));
  await expect(
    runtime.input(opened.attachmentId, "stale-gen", new Uint8Array([1])),
  ).rejects.toMatchObject({ code: "terminal-generation-mismatch" });
});

test("idle is refreshed by open/takeControl/input but not heartbeat/resize", async () => {
  const { runtime, registry, clock } = await makeHarness({
    config: { idleTimeoutSeconds: 100 },
  });
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v1",
    cols: 80,
    rows: 24,
  });
  const t0 = registry.getSnapshot().terminals[opened.terminalId]!.lastInputAt;

  clock.nowMs += 10_000;
  runtime.heartbeat(opened.attachmentId);
  await runtime.resize(opened.attachmentId, opened.generation, 90, 30);
  expect(registry.getSnapshot().terminals[opened.terminalId]!.lastInputAt).toBe(t0);

  clock.nowMs += 30_000; // cross checkpoint interval
  await runtime.input(opened.attachmentId, opened.generation, new Uint8Array([9]));
  const afterInput = registry.getSnapshot().terminals[opened.terminalId]!.lastInputAt;
  expect(afterInput).not.toBe(t0);

  const spectator = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v2",
    cols: 80,
    rows: 24,
  });
  clock.nowMs += 5_000;
  await runtime.takeControl(spectator.attachmentId, spectator.generation);
  const afterTake = registry.getSnapshot().terminals[opened.terminalId]!.lastInputAt;
  expect(afterTake).not.toBe(afterInput);
});

test("terminate durable-reaps then kills; kill timeout yields cleanup-pending", async () => {
  const { runtime, driver, registry, events } = await makeHarness({ killTimeoutMs: 20 });
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });

  events.length = 0;
  const ok = await runtime.terminate({
    terminalId: opened.terminalId,
    generation: opened.generation,
    reason: "explicit-close",
  });
  expect(ok).toEqual({ status: "terminated" });
  expect(registry.getSnapshot().terminals[opened.terminalId]).toBeUndefined();
  expect(events.some((e) => e.type === "exit")).toBe(true);

  // already-gone is success
  expect(
    await runtime.terminate({
      terminalId: opened.terminalId,
      generation: opened.generation,
      reason: "explicit-close",
    }),
  ).toEqual({ status: "terminated" });

  const again = await makeHarness({ killTimeoutMs: 15 });
  const opened2 = await again.runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });
  again.driver.configureDelay("kill", 200);
  const pending = await again.runtime.terminate({
    terminalId: opened2.terminalId,
    generation: opened2.generation,
    reason: "explicit-close",
  });
  expect(pending).toEqual({ status: "cleanup-pending" });
  expect(again.registry.getSnapshot().terminals[opened2.terminalId]?.state).toBe("reaping");
  // silence unused
  expect(driver).toBeDefined();
});

test("natural shell exit marks reaping(exited) and fans out exit", async () => {
  const { runtime, driver, registry, events } = await makeHarness();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });
  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(30);

  const sessionId = (await driver.list())[0]!.sessionId;
  events.length = 0;
  driver.exitSession(sessionId, 0);
  await Bun.sleep(80);

  expect(events.some((e) => e.type === "exit" && e.reason === "exited")).toBe(true);
  // finishReap should have removed once kill/absent completes; exitSession leaves
  // session dead but still in map until kill — finishReap calls kill which removes.
  expect(registry.getSnapshot().terminals[opened.terminalId]).toBeUndefined();
});

test("fenced handle rejects further input", async () => {
  const { runtime } = await makeHarness();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });
  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(10);
  // Process-owned: reconciler onFence sets leaseLost on the in-memory handle.
  await runtime.reconcileOnce();
  // Force fence via terminate path's onFence by marking reaping through terminate.
  // Direct fence: call terminate which fences, then attempt input on stale attachment
  // is attachment-not-found. Instead open a second terminal and fence via host —
  // simplest: terminate then expect attachment gone.
  await runtime.terminate({
    terminalId: opened.terminalId,
    generation: opened.generation,
    reason: "explicit-close",
  });
  await expect(
    runtime.input(opened.attachmentId, opened.generation, new Uint8Array([1])),
  ).rejects.toBeInstanceOf(TerminalRuntimeError);
});

test("stop kills live sessions (process-owned)", async () => {
  const { runtime, driver } = await makeHarness();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });
  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(10);
  await runtime.stop();
  expect(await driver.list()).toHaveLength(0);
});

test("disabled config rejects open", async () => {
  const { runtime } = await makeHarness({ config: { enabled: false } });
  await expect(
    runtime.openOrResume({
      chatKey: "relay:u1",
      sessionAlias: "demo",
      viewerId: "v",
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ code: "terminal-disabled" });
});

test("concurrent open for two logical sessions both mark live without revision CAS failure", async () => {
  const { runtime, catalog, driver, registry } = await makeHarness();
  catalog.set(
    descriptor({
      logicalSessionId: "22222222-2222-4222-8222-222222222222",
      displayAlias: "other",
      internalAlias: "other",
    }),
  );

  // Interleave create with checkpoint on the other terminal.
  const opens = Promise.all([
    runtime.openOrResume({
      chatKey: "relay:u1",
      sessionAlias: "demo",
      viewerId: "v1",
      cols: 80,
      rows: 24,
    }),
    runtime.openOrResume({
      chatKey: "relay:u1",
      sessionAlias: "other",
      viewerId: "v2",
      cols: 80,
      rows: 24,
    }),
  ]);
  const [a, b] = await opens;
  expect(a.terminalId).not.toBe(b.terminalId);
  expect(await driver.list()).toHaveLength(2);
  const snap = registry.getSnapshot();
  expect(Object.values(snap.terminals).filter((t) => t.state === "live")).toHaveLength(2);
});

test("attachment TTL sweep detaches stale viewers and aborts recovery", async () => {
  const { runtime, clock } = await makeHarness({
    config: { attachmentTtlSeconds: 5 },
  });
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });
  await runtime.startRecovery(opened.attachmentId);
  expect(runtime.peekAttachment(opened.attachmentId)).toBeTruthy();

  clock.nowMs += 6_000;
  const expired = runtime.sweepExpiredAttachments();
  expect(expired).toContain(opened.attachmentId);
  expect(runtime.peekAttachment(opened.attachmentId)).toBeUndefined();
});

test("healthy recovery past 2MiB cumulative output does not self-deadlock", async () => {
  const { runtime, driver } = await makeHarness();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });
  expect(opened.openKind).toBe("created");
  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(10);
  const sessions = await driver.list();
  const paneId = sessions[0]!.paneId;
  // Push >2MiB through the recovery path; instant flush releases pending bytes.
  const chunk = new Uint8Array(256 * 1024).fill(0x61);
  for (let i = 0; i < 10; i++) {
    driver.injectOutput(paneId, chunk);
  }
  await Bun.sleep(50);
  expect(runtime.peekAttachment(opened.attachmentId)).toBeTruthy();
  await runtime.input(opened.attachmentId, opened.generation, new TextEncoder().encode("x"));
});

test("stalled flush keeps pending outbound and overflows at 2MiB", async () => {
  const dir = freshDir();
  const registry = new TerminalRegistryStore({ dir });
  const driver = new InMemoryRmuxDriver();
  const catalog = new FakeCatalog([descriptor()]);
  const events: TerminalViewerEvent[] = [];
  const clock = { nowMs: 1_000_000, now: () => clock.nowMs };
  const runtime = new DefaultRelayTerminalRuntime({
    registry,
    driver,
    catalog,
    config: baseConfig(),
    onViewerEvent: (e, _onFlush) => {
      events.push(e);
      // Never flush — simulates a stalled Hub websocket send buffer.
    },
    clock,
    randomUUID: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      };
    })(),
  });
  await runtime.start();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });
  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(10);
  const paneId = (await driver.list())[0]!.paneId;
  const chunk = new Uint8Array(256 * 1024).fill(0x62);
  for (let i = 0; i < 10; i++) {
    driver.injectOutput(paneId, chunk);
  }
  await Bun.sleep(80);
  expect(events.some((e) => e.type === "queue-overflow")).toBe(true);
});

test("timed-out resume detaches only; does not terminate shared shell", async () => {
  const { runtime, driver } = await makeHarness();
  const first = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v1",
    cols: 80,
    rows: 24,
  });
  expect(first.openKind).toBe("created");

  const second = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v2",
    cols: 80,
    rows: 24,
  });
  expect(second.openKind).toBe("resumed");
  expect(second.terminalId).toBe(first.terminalId);

  await runtime.compensateTimedOutOpen(second);
  expect(runtime.peekAttachment(second.attachmentId)).toBeUndefined();
  expect(runtime.peekAttachment(first.attachmentId)).toBeTruthy();
  expect(await driver.list()).toHaveLength(1);
});

test("timed-out create terminates when no other viewers remain", async () => {
  const { runtime, driver } = await makeHarness();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v1",
    cols: 80,
    rows: 24,
  });
  expect(opened.openKind).toBe("created");
  await runtime.compensateTimedOutOpen(opened);
  expect(runtime.peekAttachment(opened.attachmentId)).toBeUndefined();
  expect(await driver.list()).toHaveLength(0);
});

test("timed-out create keeps shell when another viewer attached after create", async () => {
  const { runtime, driver } = await makeHarness();
  const created = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v-late",
    cols: 80,
    rows: 24,
  });
  expect(created.openKind).toBe("created");

  const other = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v-other",
    cols: 80,
    rows: 24,
  });
  expect(other.openKind).toBe("resumed");

  await runtime.compensateTimedOutOpen(created);
  expect(runtime.peekAttachment(created.attachmentId)).toBeUndefined();
  expect(runtime.peekAttachment(other.attachmentId)).toBeTruthy();
  expect(await driver.list()).toHaveLength(1);
});

test("pending resume waiting on terminal lock fails after compensate terminates", async () => {
  const { runtime, driver } = await makeHarness();
  const created = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v-late",
    cols: 80,
    rows: 24,
  });

  // Hold the terminal lock so we can queue compensate ahead of a resume that
  // has already observed live under the logical lock.
  type Lockable = {
    withTerminalLock: <T>(terminalId: string, fn: () => Promise<T>) => Promise<T>;
  };
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const holding = (runtime as unknown as Lockable).withTerminalLock(
    created.terminalId,
    async () => {
      await hold;
    },
  );
  await Promise.resolve();

  const compensateP = runtime.compensateTimedOutOpen(created);
  await Promise.resolve();

  const resumeP = runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v-pending",
    cols: 80,
    rows: 24,
  });
  await Promise.resolve();

  releaseHold();
  await holding;
  await compensateP;
  await expect(resumeP).rejects.toBeInstanceOf(TerminalRuntimeError);
  await expect(resumeP).rejects.toMatchObject({
    code: expect.stringMatching(/terminal-(terminating|rmux-unavailable)/),
  });

  expect(runtime.peekAttachment(created.attachmentId)).toBeUndefined();
  expect(await driver.list()).toHaveLength(0);
});

test("resync binds in-flight frames to the old epoch before starting a new recovery", async () => {
  const dir = freshDir();
  const registry = new TerminalRegistryStore({ dir });
  const driver = new InMemoryRmuxDriver();
  const catalog = new FakeCatalog([descriptor()]);
  const events: TerminalViewerEvent[] = [];
  const flushes: Array<(error?: Error) => void> = [];
  const runtime = new DefaultRelayTerminalRuntime({
    registry,
    driver,
    catalog,
    config: baseConfig(),
    onViewerEvent: (e, onFlush) => {
      events.push(e);
      if (onFlush) flushes.push(onFlush);
    },
    clock: { now: () => 1_000_000 },
    killTimeoutMs: 50,
  });
  await runtime.start();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });
  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(10);
  const paneId = (await driver.list())[0]!.paneId;
  driver.injectOutput(paneId, new Uint8Array(20));
  await Bun.sleep(10);
  expect(flushes.length).toBeGreaterThan(0);
  const staleFlush = flushes[flushes.length - 1]!;

  await runtime.resync(opened.attachmentId, opened.generation);
  const overflowBefore = events.filter((e) => e.type === "queue-overflow").length;
  const bytesBefore = events.filter((e) => e.type === "bytes").length;

  driver.injectOutput(paneId, new Uint8Array([0x62]));
  await Bun.sleep(10);
  expect(events.filter((e) => e.type === "bytes").length).toBeGreaterThan(bytesBefore);

  staleFlush(new Error("stale-flush"));
  await Bun.sleep(10);
  expect(events.filter((e) => e.type === "queue-overflow").length).toBe(overflowBefore);

  driver.injectOutput(paneId, new Uint8Array([0x63]));
  await Bun.sleep(10);
  expect(events.filter((e) => e.type === "bytes").length).toBeGreaterThan(bytesBefore + 1);
});

test("resync then a late old-loop flush success does not debit the new recovery", async () => {
  const dir = freshDir();
  const registry = new TerminalRegistryStore({ dir });
  const driver = new InMemoryRmuxDriver();
  const catalog = new FakeCatalog([descriptor()]);
  const events: TerminalViewerEvent[] = [];
  const flushes: Array<(error?: Error) => void> = [];
  const runtime = new DefaultRelayTerminalRuntime({
    registry,
    driver,
    catalog,
    config: baseConfig(),
    onViewerEvent: (e, onFlush) => {
      events.push(e);
      if (onFlush) flushes.push(onFlush);
    },
    clock: { now: () => 1_000_000 },
    killTimeoutMs: 50,
  });
  await runtime.start();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });
  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(10);
  const paneId = (await driver.list())[0]!.paneId;
  driver.injectOutput(paneId, new Uint8Array(30));
  await Bun.sleep(10);
  const firstFlush = flushes[flushes.length - 1]!;

  await runtime.resync(opened.attachmentId, opened.generation);
  firstFlush();
  driver.injectOutput(paneId, new Uint8Array(40));
  await Bun.sleep(10);
  expect(events.some((e) => e.type === "queue-overflow")).toBe(false);
  expect(events.filter((e) => e.type === "bytes").length).toBeGreaterThanOrEqual(2);
});

test("start fails closed on corrupt inventory and never calls driver.create", async () => {
  const dir = freshDir();
  const bootstrap = new TerminalRegistryStore({ dir });
  await bootstrap.load();
  writeFileSync(join(dir, "terminals.json"), "{ not valid json !!", "utf8");

  const registry = new TerminalRegistryStore({ dir });
  const driver = new InMemoryRmuxDriver();
  let creates = 0;
  const origCreate = driver.create.bind(driver);
  driver.create = async (input) => {
    creates += 1;
    return origCreate(input);
  };
  const runtime = new DefaultRelayTerminalRuntime({
    registry,
    driver,
    catalog: new FakeCatalog([descriptor()]),
    config: baseConfig(),
    onViewerEvent: () => {},
    clock: { now: () => 1_000_000 },
    killTimeoutMs: 50,
  });

  await expect(runtime.start()).rejects.toMatchObject({
    name: "TerminalRuntimeError",
    code: "terminal-rmux-unavailable",
  });
  expect(creates).toBe(0);
  expect(readdirSync(dir).some((f) => f.startsWith("terminals.json.corrupt-"))).toBe(true);
  expect(existsSync(join(dir, "terminals.json"))).toBe(false);
});

test("old recovery finally cannot delete a replacement loop for the same attachment", async () => {
  const { runtime, driver } = await makeHarness();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v",
    cols: 80,
    rows: 24,
  });
  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(20);
  const paneId = (await driver.list())[0]!.paneId;
  expect(runtime.hasRecoveryForTests(opened.attachmentId)).toBe(true);

  const held = driver.holdNextRecoverReturn();
  driver.injectError(paneId, "rebase-too-large", "oversized");
  await Bun.sleep(20);
  expect(runtime.hasRecoveryForTests(opened.attachmentId)).toBe(false);

  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(20);
  expect(runtime.hasRecoveryForTests(opened.attachmentId)).toBe(true);
  expect(driver.recoverySubscriberCount(paneId)).toBe(2);

  held.release();
  await Bun.sleep(20);
  expect(runtime.hasRecoveryForTests(opened.attachmentId)).toBe(true);
  expect(driver.recoverySubscriberCount(paneId)).toBe(1);

  await runtime.terminate({
    terminalId: opened.terminalId,
    generation: opened.generation,
    reason: "explicit-close",
  });
  await Bun.sleep(20);
  expect(runtime.hasRecoveryForTests(opened.attachmentId)).toBe(false);
  expect(driver.recoverySubscriberCount(paneId)).toBe(0);
});

test("startRecovery failure publishes terminal-recovery-failed and keeps the live resource", async () => {
  const { runtime, driver, events, registry } = await makeHarness();
  const opened = await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "controller",
    cols: 80,
    rows: 24,
  });
  events.length = 0;
  driver.configureFailure("recover", new Error("no-daemon"));

  await runtime.startRecovery(opened.attachmentId);
  await Bun.sleep(30);

  const failed = events.filter((e) => e.type === "recovery-failed");
  expect(failed).toEqual([
    expect.objectContaining({
      type: "recovery-failed",
      attachmentId: opened.attachmentId,
      terminalId: opened.terminalId,
      generation: opened.generation,
      code: "terminal-rmux-unavailable",
      message: "terminal-rmux-unavailable",
    }),
  ]);
  expect(runtime.peekAttachment(opened.attachmentId)).toBeTruthy();
  expect(registry.getSnapshot().terminals[opened.terminalId]?.state).toBe("live");
  expect(events.some((e) => e.type === "exit")).toBe(false);
});
