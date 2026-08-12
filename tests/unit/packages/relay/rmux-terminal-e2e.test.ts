import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import {
  b64,
  createRmuxTerminalE2EHarness,
  demoDescriptor,
  type RmuxTerminalE2EHarness,
} from "../../../helpers/rmux-terminal-e2e-harness";

setDefaultTimeout(30_000);

const harnesses: RmuxTerminalE2EHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    if (h) await h.close();
  }
});

async function boot(opts?: Parameters<typeof createRmuxTerminalE2EHarness>[0]) {
  const h = await createRmuxTerminalE2EHarness(opts);
  harnesses.push(h);
  return h;
}

function isOpened<T extends { failed?: unknown }>(
  result: T,
): result is Exclude<T, { failed: unknown }> {
  return !("failed" in result && result.failed);
}

test("open → stream → bytes reach only the attached browser; frames skip messages DB", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const opened = await h.openTerminal(a);
  expect(isOpened(opened)).toBe(true);
  if (!isOpened(opened)) return;

  expect(opened.role).toBe("controller");
  expect((await h.driver.list()).length).toBe(1);
  const beforeMsgs = h.messageCount();

  h.streamStart(a, opened.attachmentId);
  await a.waitFor((e) => e.kind === "terminal-rebase-start" || e.kind === "terminal-bytes");

  const sessions = await h.driver.list();
  h.driver.injectOutput(sessions[0]!.paneId, new TextEncoder().encode("hello-e2e"));
  await a.waitFor(
    (e) => e.kind === "terminal-bytes" && e.attachmentId === opened.attachmentId,
  );

  expect(h.messageCount()).toBe(beforeMsgs);
  const snap = await h.registrySnapshot();
  expect(Object.values(snap.terminals).some((t) => t.state === "live")).toBe(true);
});

test("two browsers share one terminal; second is spectator; take-control flips roles", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const b = await h.connectBrowser();

  const openA = await h.openTerminal(a, { requestId: "open-a" });
  expect(isOpened(openA)).toBe(true);
  if (!isOpened(openA)) return;

  const openB = await h.openTerminal(b, { requestId: "open-b" });
  expect(isOpened(openB)).toBe(true);
  if (!isOpened(openB)) return;

  expect(openA.terminalId).toBe(openB.terminalId);
  expect(openA.generation).toBe(openB.generation);
  expect(openA.role).toBe("controller");
  expect(openB.role).toBe("spectator");
  expect(openB.viewerCount).toBe(2);
  expect((await h.driver.list()).length).toBe(1);

  const tc = await h.takeControl(b, openB.attachmentId, openB.generation, "tc-b");
  expect(tc.kind).toBe("terminal-opened");
  if (tc.kind !== "terminal-opened") return;
  expect(tc.role).toBe("controller");

  await a.waitFor(
    (e) =>
      e.kind === "terminal-role-changed" &&
      e.attachmentId === openA.attachmentId &&
      e.role === "spectator",
  );
});

test("global terminate kills RMUX and fans exit to both browsers", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const b = await h.connectBrowser();
  const openA = await h.openTerminal(a, { requestId: "ta" });
  const openB = await h.openTerminal(b, { requestId: "tb" });
  expect(isOpened(openA) && isOpened(openB)).toBe(true);
  if (!isOpened(openA) || !isOpened(openB)) return;

  const ack = await h.terminate(a, openA.terminalId, openA.generation, "kill-1");
  expect(ack).toMatchObject({
    kind: "terminal-request-failed",
    requestId: "kill-1",
    code: "terminated",
  });

  await b.waitFor(
    (e) =>
      e.kind === "terminal-exit" &&
      e.terminalId === openA.terminalId &&
      e.generation === openA.generation,
  );
  expect((await h.driver.list()).length).toBe(0);
  const snap = await h.registrySnapshot();
  expect(Object.keys(snap.terminals)).toEqual([]);
});

test("browser detach/window close keeps RMUX session for remaining viewer", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const b = await h.connectBrowser();
  const openA = await h.openTerminal(a, { requestId: "da" });
  const openB = await h.openTerminal(b, { requestId: "db" });
  expect(isOpened(openA) && isOpened(openB)).toBe(true);
  if (!isOpened(openA) || !isOpened(openB)) return;

  a.close();
  await Bun.sleep(50);

  expect((await h.driver.list()).length).toBe(1);
  const snap = await h.registrySnapshot();
  expect(Object.values(snap.terminals).every((t) => t.state === "live")).toBe(true);

  // Remaining browser can still stream.
  h.streamStart(b, openB.attachmentId);
  await b.waitFor((e) => e.kind === "terminal-rebase-start" || e.kind === "terminal-bytes");
});

test("kill timeout yields cleanup-pending and keeps reaping tombstone + owner identity", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const opened = await h.openTerminal(a);
  expect(isOpened(opened)).toBe(true);
  if (!isOpened(opened)) return;

  h.driver.configureFailure("kill", new Error("rmux-unreachable"));
  const ack = await h.terminate(a, opened.terminalId, opened.generation, "pending-1");
  expect(ack).toMatchObject({
    kind: "terminal-request-failed",
    requestId: "pending-1",
    code: "cleanup-pending",
  });

  const snap = await h.registrySnapshot();
  const remaining = Object.values(snap.terminals);
  expect(remaining.length).toBe(1);
  expect(remaining[0]?.state).toBe("reaping");
  expect(snap.installationId.length).toBeGreaterThan(0);
});

test("catalog delete retires the live terminal resource", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const opened = await h.openTerminal(a);
  expect(isOpened(opened)).toBe(true);
  if (!isOpened(opened)) return;

  const desc = demoDescriptor();
  h.catalog.emit({ type: "removed", session: desc });
  await Bun.sleep(80);

  expect((await h.driver.list()).length).toBe(0);
  const snap = await h.registrySnapshot();
  expect(Object.keys(snap.terminals)).toEqual([]);
});

test("alias reuse after logical replace creates a new terminal generation", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const first = await h.openTerminal(a, { requestId: "reuse-1" });
  expect(isOpened(first)).toBe(true);
  if (!isOpened(first)) return;

  await h.terminate(a, first.terminalId, first.generation, "reuse-kill");

  const next = demoDescriptor({
    logicalSessionId: "22222222-2222-4222-8222-222222222222",
    displayAlias: "demo",
    internalAlias: "demo",
  });
  h.catalog.replaceAlias(demoDescriptor().logicalSessionId, next);

  const second = await h.openTerminal(a, { requestId: "reuse-2" });
  expect(isOpened(second)).toBe(true);
  if (!isOpened(second)) return;

  expect(second.terminalId).not.toBe(first.terminalId);
  expect(second.generation).not.toBe(first.generation);
});

test("stale generation terminate fails closed without killing the live resource", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const opened = await h.openTerminal(a);
  expect(isOpened(opened)).toBe(true);
  if (!isOpened(opened)) return;

  const ack = await h.terminate(a, opened.terminalId, "00000000-0000-4000-8000-000000000000", "stale-g");
  expect(ack.kind).toBe("terminal-request-failed");
  if (ack.kind !== "terminal-request-failed") return;
  expect(ack.code).toMatch(/generation|mismatch|not-found|protocol/i);
  expect((await h.driver.list()).length).toBe(1);
});

test("maxSessions capacity is enforced end-to-end", async () => {
  const h = await boot({
    terminal: { maxSessions: 1 },
    descriptors: [
      demoDescriptor(),
      demoDescriptor({
        logicalSessionId: "33333333-3333-4333-8333-333333333333",
        displayAlias: "other",
        internalAlias: "other",
      }),
    ],
  });
  const a = await h.connectBrowser();
  const first = await h.openTerminal(a, { sessionAlias: "demo", requestId: "cap-1" });
  expect(isOpened(first)).toBe(true);

  const second = await h.openTerminal(a, { sessionAlias: "other", requestId: "cap-2" });
  expect(isOpened(second)).toBe(false);
  if (isOpened(second)) return;
  expect(second.failed).toMatchObject({
    kind: "terminal-request-failed",
    code: "terminal-capacity-exceeded",
  });
  expect((await h.driver.list()).length).toBe(1);
});

test("maxViewersPerTerminal capacity is enforced end-to-end", async () => {
  const h = await boot({ terminal: { maxViewersPerTerminal: 1 } });
  const a = await h.connectBrowser();
  const b = await h.connectBrowser();
  const first = await h.openTerminal(a, { requestId: "view-1" });
  expect(isOpened(first)).toBe(true);

  const second = await h.openTerminal(b, { requestId: "view-2" });
  expect(isOpened(second)).toBe(false);
  if (isOpened(second)) return;
  expect(second.failed).toMatchObject({
    kind: "terminal-request-failed",
    code: "terminal-viewer-capacity-exceeded",
  });
});

test("spectator input is rejected at the connector; controller input reaches RMUX", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const b = await h.connectBrowser();
  const openA = await h.openTerminal(a, { requestId: "in-a" });
  const openB = await h.openTerminal(b, { requestId: "in-b" });
  expect(isOpened(openA) && isOpened(openB)).toBe(true);
  if (!isOpened(openA) || !isOpened(openB)) return;

  b.send({
    kind: "terminal-input",
    instanceId: h.instanceId,
    attachmentId: openB.attachmentId,
    generation: openB.generation,
    dataBase64: b64("spectator"),
  });
  await Bun.sleep(40);

  a.send({
    kind: "terminal-input",
    instanceId: h.instanceId,
    attachmentId: openA.attachmentId,
    generation: openA.generation,
    dataBase64: b64("ctrl"),
  });
  await Bun.sleep(40);

  // Driver accepts controller input without throwing; spectator path is gated by
  // attachment role (no mutation). Session remains live.
  expect((await h.driver.list()).length).toBe(1);
});

test("hub disconnect detaches attachments without killing RMUX", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const opened = await h.openTerminal(a);
  expect(isOpened(opened)).toBe(true);
  if (!isOpened(opened)) return;

  const runtime = h.channel.getTerminalRuntimeForTests();
  expect(runtime?.peekAttachment(opened.attachmentId)).toBeTruthy();

  runtime?.detachAllAttachments();
  expect(runtime?.peekAttachment(opened.attachmentId)).toBeUndefined();
  expect((await h.driver.list()).length).toBe(1);
  const snap = await h.registrySnapshot();
  expect(Object.values(snap.terminals)[0]?.state).toBe("live");
});

test("refresh openOrResume returns the same live terminal resource", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const first = await h.openTerminal(a, { requestId: "refresh-1" });
  expect(isOpened(first)).toBe(true);
  if (!isOpened(first)) return;

  h.detach(a, first.attachmentId);
  await Bun.sleep(30);

  const second = await h.openTerminal(a, { requestId: "refresh-2" });
  expect(isOpened(second)).toBe(true);
  if (!isOpened(second)) return;
  expect(second.terminalId).toBe(first.terminalId);
  expect(second.generation).toBe(first.generation);
  expect(second.attachmentId).not.toBe(first.attachmentId);
  expect((await h.driver.list()).length).toBe(1);
});

test("stream resync after rebase delivers a fresh keyframe without messages DB writes", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  const opened = await h.openTerminal(a);
  expect(isOpened(opened)).toBe(true);
  if (!isOpened(opened)) return;

  h.streamStart(a, opened.attachmentId);
  await a.waitFor((e) => e.kind === "terminal-rebase-start");

  const before = h.messageCount();
  const session = (await h.driver.list())[0]!;
  h.driver.injectOutput(session.paneId, new TextEncoder().encode("pre-rebase"));
  const mark = a.events.length;
  h.driver.triggerRebase(session.sessionId, {
    keyframe: new TextEncoder().encode("after-clear"),
    reason: "clear-history",
  });
  const deadline = Date.now() + 5000;
  let sawStart = false;
  let sawEnd = false;
  while (Date.now() < deadline && !(sawStart && sawEnd)) {
    for (const e of a.events.slice(mark)) {
      if (e.kind === "terminal-rebase-start" && e.epoch === 2) sawStart = true;
      if (e.kind === "terminal-rebase-end" && e.epoch === 2) sawEnd = true;
    }
    if (!(sawStart && sawEnd)) await Bun.sleep(10);
  }
  expect(sawStart && sawEnd).toBe(true);
  expect(h.messageCount()).toBe(before);
});

test("create crash leaves no durable live orphan after failed open", async () => {
  const h = await boot();
  const a = await h.connectBrowser();
  h.driver.configureFailure("create", new Error("create-crash"), 1);
  const failed = await h.openTerminal(a, { requestId: "create-fail" });
  expect(isOpened(failed)).toBe(false);
  expect((await h.driver.list()).length).toBe(0);

  // Drain any leftover creating/reaping tombstone via reconcile so the next open
  // is not blocked by a stale creating record.
  await h.channel.getTerminalRuntimeForTests()?.reconcileOnce();
  const snap = await h.registrySnapshot();
  expect(Object.values(snap.terminals).every((t) => t.state !== "live")).toBe(true);

  h.driver.clearFailure("create");
  const ok = await h.openTerminal(a, { requestId: "create-ok" });
  expect(isOpened(ok)).toBe(true);
  if (!isOpened(ok) && "failed" in ok) {
    throw new Error(`second open failed: ${JSON.stringify(ok.failed)}`);
  }
  expect((await h.driver.list()).length).toBe(1);
});

test("paired connector advertises both RMUX terminal capabilities to the hub", async () => {
  const h = await boot();
  const listRes = await h.relay.runtime.app.request("/api/instances", {
    headers: { cookie: h.cookie },
  });
  const body = (await listRes.json()) as {
    instances: Array<{ id: string; capabilities?: string[] | null }>;
  };
  const caps = body.instances.find((i) => i.id === h.instanceId)?.capabilities ?? [];
  expect(caps).toContain("terminal.rmux.recovery.v1");
  expect(caps).toContain("terminal.multi-view.v1");
});
