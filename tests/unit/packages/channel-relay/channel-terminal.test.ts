import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MSG, RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";
import { InMemoryRmuxDriver } from "../../../../packages/channel-relay/src/terminal/in-memory-rmux-driver";
import type {
  SessionResourceCatalog,
  SessionResourceDescriptor,
  SessionResourceLifecycleEvent,
} from "xacpx/plugin-api";

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function descriptor(overrides: Partial<SessionResourceDescriptor> = {}): SessionResourceDescriptor {
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
  private readonly listeners = new Set<(e: SessionResourceLifecycleEvent) => void>();
  constructor(private readonly items: SessionResourceDescriptor[] = [descriptor()]) {}
  async resolve(_c: string, alias: string) {
    return this.items.find((d) => d.displayAlias === alias) ?? null;
  }
  async list(channelId: string) {
    return this.items.filter((d) => d.channelId === channelId);
  }
  subscribe(listener: (e: SessionResourceLifecycleEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: SessionResourceLifecycleEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  if (!pred()) throw new Error(`timed out waiting for ${label}`);
}

function makeStartInput(overrides: Record<string, unknown> = {}) {
  const subscribed: unknown[] = [];
  return {
    input: {
      agent: { chat: async () => ({ text: "" }) },
      abortSignal: new AbortController().signal,
      quota: {} as never,
      logger: { info: async () => {}, error: async () => {}, debug: async () => {} },
      control: {
        events: { subscribe: (listener: unknown) => { subscribed.push(listener); return () => {}; } },
        listSessions: () => [],
      },
      coreVersion: "0.17.0",
      ...overrides,
    },
    subscribed,
  };
}

test("terminal.enabled without sessionResources fails closed at start", async () => {
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t", terminal: { enabled: true } },
    { credentialStore: new MemoryCredentialStore() },
  );
  const { input } = makeStartInput();
  await expect(channel.start(input as never)).rejects.toThrow(/sessionResources/);
});

test("terminal.enabled declares both capabilities after runtime reconcile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-term-chan-"));
  dirs.push(dir);
  let capturedCaps: string[] | undefined;
  const fakeClient = {
    start: () => {},
    stop: () => {},
    sendEvent: () => {},
  };
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t", terminal: { enabled: true } },
    {
      credentialStore: new MemoryCredentialStore(),
      terminalRegistryDir: dir,
      createTerminalDriver: () => new InMemoryRmuxDriver(),
      createClient: (opts) => {
        capturedCaps = opts.capabilities;
        return fakeClient as never;
      },
    },
  );
  const controller = new AbortController();
  const { input } = makeStartInput({
    abortSignal: controller.signal,
    sessionResources: new FakeCatalog(),
  });
  const started = channel.start(input as never);
  const deadline = Date.now() + 2000;
  while (capturedCaps === undefined && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(capturedCaps).toEqual([
    RELAY_CAPABILITIES.terminalRmuxRecoveryV1,
    RELAY_CAPABILITIES.terminalMultiViewV1,
  ]);
  expect(channel.getTerminalRuntimeForTests()).not.toBeNull();
  controller.abort();
  await started;
});

test("terminal open request routes to runtime and does not hit legacy control bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-term-chan-"));
  dirs.push(dir);
  let onRequest: ((envelope: { kind: string; type: string; payload: unknown }, respond: (p: unknown) => void) => void) | undefined;
  const fakeClient = {
    start: () => {},
    stop: () => {},
    sendEvent: () => {},
  };
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t", terminal: { enabled: true } },
    {
      credentialStore: new MemoryCredentialStore(),
      terminalRegistryDir: dir,
      createTerminalDriver: () => new InMemoryRmuxDriver(),
      createClient: (opts) => {
        onRequest = opts.onRequest as never;
        return fakeClient as never;
      },
    },
  );
  const controller = new AbortController();
  const { input } = makeStartInput({
    abortSignal: controller.signal,
    sessionResources: new FakeCatalog(),
  });
  const started = channel.start(input as never);
  await waitUntil(() => typeof onRequest === "function", "onRequest");

  let response: unknown;
  await new Promise<void>((resolve) => {
    onRequest!(
      {
        kind: "req",
        type: MSG.terminalOpen,
        payload: {
          chatKey: "relay:u1",
          sessionAlias: "demo",
          viewerId: "viewer-1",
          cols: 80,
          rows: 24,
        },
      },
      (payload) => {
        response = payload;
        resolve();
      },
    );
  });
  expect(response).toMatchObject({
    role: "controller",
    viewerCount: 1,
  });

  controller.abort();
  await started;
});

test("hub disconnect bulk-detaches attachments; stop(shutdown) kills RMUX (process-owned)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-term-chan-"));
  dirs.push(dir);
  const driver = new InMemoryRmuxDriver();
  let onDisconnected: (() => void) | undefined;
  let onRequest: ((envelope: { kind: string; type: string; payload: unknown }, respond: (p: unknown) => void) => void) | undefined;
  const fakeClient = {
    start: () => {},
    stop: () => {},
    sendEvent: () => {},
  };
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t", terminal: { enabled: true } },
    {
      credentialStore: new MemoryCredentialStore(),
      terminalRegistryDir: dir,
      createTerminalDriver: () => driver,
      createClient: (opts) => {
        onDisconnected = opts.onDisconnected;
        onRequest = opts.onRequest as never;
        return fakeClient as never;
      },
    },
  );
  const controller = new AbortController();
  const { input } = makeStartInput({
    abortSignal: controller.signal,
    sessionResources: new FakeCatalog(),
  });
  const started = channel.start(input as never);
  await waitUntil(() => typeof onRequest === "function", "onRequest");

  let opened: { attachmentId: string } | undefined;
  await new Promise<void>((resolve) => {
    onRequest!(
      {
        kind: "req",
        type: MSG.terminalOpen,
        payload: {
          chatKey: "relay:u1",
          sessionAlias: "demo",
          viewerId: "viewer-1",
          cols: 80,
          rows: 24,
        },
      },
      (payload) => {
        opened = payload as { attachmentId: string };
        resolve();
      },
    );
  });

  expect((await driver.list()).length).toBe(1);
  onDisconnected!();
  const runtime = channel.getTerminalRuntimeForTests()!;
  expect(runtime.peekAttachment?.(opened!.attachmentId)).toBeUndefined();
  expect((await driver.list()).length).toBe(1);

  controller.abort();
  await started;
  // After shutdown stop: process-owned kills sessions.
  expect((await driver.list()).length).toBe(0);
});

test("stop(disabled) terminates RMUX after durable reaping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-term-chan-"));
  dirs.push(dir);
  const driver = new InMemoryRmuxDriver();
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t", terminal: { enabled: true } },
    {
      credentialStore: new MemoryCredentialStore(),
      terminalRegistryDir: dir,
      createTerminalDriver: () => driver,
      createClient: () => ({ start: () => {}, stop: () => {}, sendEvent: () => {} }) as never,
    },
  );
  const controller = new AbortController();
  const { input } = makeStartInput({
    abortSignal: controller.signal,
    sessionResources: new FakeCatalog(),
  });
  const started = channel.start(input as never);
  const deadline = Date.now() + 2000;
  while (channel.getTerminalRuntimeForTests() === null && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  const runtime = channel.getTerminalRuntimeForTests()!;
  await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v1",
    cols: 80,
    rows: 24,
  });
  expect((await driver.list()).length).toBe(1);

  await channel.stop("disabled");
  expect((await driver.list()).length).toBe(0);
  controller.abort();
  await started;
});

test("terminal disabled omits capabilities and still starts chat client", async () => {
  let capturedCaps: string[] | undefined;
  const fakeClient = {
    start: () => {},
    stop: () => {},
    sendEvent: () => {},
  };
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t" },
    {
      credentialStore: new MemoryCredentialStore(),
      createClient: (opts) => {
        capturedCaps = opts.capabilities;
        return fakeClient as never;
      },
    },
  );
  const controller = new AbortController();
  const { input } = makeStartInput({ abortSignal: controller.signal });
  const started = channel.start(input as never);
  await Bun.sleep(10);
  expect(capturedCaps ?? []).toEqual([]);
  controller.abort();
  await started;
});

test("valid owner + corrupt terminals.json does not advertise terminal capabilities or create shells", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-term-chan-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "terminal-owner.json"),
    JSON.stringify({ schemaVersion: 1, installationId: "11111111-1111-4111-8111-111111111111" }),
    "utf8",
  );
  writeFileSync(join(dir, "terminals.json"), "{ not valid json !!", "utf8");

  let capturedCaps: string[] | undefined;
  let creates = 0;
  const driver = new InMemoryRmuxDriver();
  const origCreate = driver.create.bind(driver);
  driver.create = async (input) => {
    creates += 1;
    return origCreate(input);
  };
  const fakeClient = {
    start: () => {},
    stop: () => {},
    sendEvent: () => {},
  };
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t", terminal: { enabled: true } },
    {
      credentialStore: new MemoryCredentialStore(),
      terminalRegistryDir: dir,
      createTerminalDriver: () => driver,
      createClient: (opts) => {
        capturedCaps = opts.capabilities;
        return fakeClient as never;
      },
    },
  );
  const controller = new AbortController();
  const { input } = makeStartInput({
    abortSignal: controller.signal,
    sessionResources: new FakeCatalog(),
  });
  const started = channel.start(input as never);
  const deadline = Date.now() + 2000;
  while (capturedCaps === undefined && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(capturedCaps).toEqual([]);
  expect(channel.getTerminalRuntimeForTests()).toBeNull();
  expect(creates).toBe(0);
  expect(readdirSync(dir).some((f) => f.startsWith("terminals.json.corrupt-"))).toBe(true);
  expect(existsSync(join(dir, "terminals.json"))).toBe(false);
  controller.abort();
  await started;
});

test("catalog retire rejection is isolated and does not become unhandled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-term-chan-"));
  dirs.push(dir);
  const catalog = new FakeCatalog();
  const errors: string[] = [];
  const rejections: unknown[] = [];
  const onRej = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRej);
  const fakeClient = { start: () => {}, stop: () => {}, sendEvent: () => {} };
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t", terminal: { enabled: true } },
    {
      credentialStore: new MemoryCredentialStore(),
      terminalRegistryDir: dir,
      createTerminalDriver: () => new InMemoryRmuxDriver(),
      createClient: () => fakeClient as never,
    },
  );
  const controller = new AbortController();
  const { input } = makeStartInput({
    abortSignal: controller.signal,
    sessionResources: catalog,
    logger: {
      info: async () => {},
      error: async (_id: string, message: string) => {
        errors.push(message);
      },
      debug: async () => {},
    },
  });
  const started = channel.start(input as never);
  try {
    const waitUntil = Date.now() + 2000;
    while (channel.getTerminalRuntimeForTests() === null && Date.now() < waitUntil) {
      await Bun.sleep(5);
    }
    const runtime = channel.getTerminalRuntimeForTests();
    expect(runtime).not.toBeNull();
    runtime!.retireLogicalSession = async () => {
      throw new Error("retire boom");
    };
    catalog.emit({ type: "removed", session: descriptor() });
    await Bun.sleep(30);
    expect(rejections).toEqual([]);
    expect(errors.some((message) => message.includes("retire boom"))).toBe(true);
  } finally {
    process.off("unhandledRejection", onRej);
    controller.abort();
    await started;
  }
});

test("in-flight catalog retirement is drained before stop closes the runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-term-chan-"));
  dirs.push(dir);
  const catalog = new FakeCatalog();
  const fakeClient = { start: () => {}, stop: () => {}, sendEvent: () => {} };
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t", terminal: { enabled: true } },
    {
      credentialStore: new MemoryCredentialStore(),
      terminalRegistryDir: dir,
      createTerminalDriver: () => new InMemoryRmuxDriver(),
      createClient: () => fakeClient as never,
    },
  );
  const controller = new AbortController();
  const { input } = makeStartInput({
    abortSignal: controller.signal,
    sessionResources: catalog,
  });
  const started = channel.start(input as never);
  const waitUntil = Date.now() + 2000;
  while (channel.getTerminalRuntimeForTests() === null && Date.now() < waitUntil) {
    await Bun.sleep(5);
  }
  const runtime = channel.getTerminalRuntimeForTests();
  expect(runtime).not.toBeNull();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  runtime!.retireLogicalSession = async () => {
    await gate;
    finished = true;
  };
  catalog.emit({ type: "archived", session: descriptor() });
  await Bun.sleep(10);
  controller.abort();
  await Bun.sleep(30);
  expect(finished).toBe(false);
  const stopState = await Promise.race([started.then(() => "stopped"), Promise.resolve("waiting")]);
  expect(stopState).toBe("waiting");
  release();
  await started;
  expect(finished).toBe(true);
});

test("terminal bootstrap handshake failure still logs bridge/rmux resolution details", async () => {
  // Regression: the supervisor is owned by the channel BEFORE start(), so a
  // spawn/handshake failure (the exact 0.9/0.10 class of field failure) must
  // still produce relay.terminal_bootstrap_failed with source + redacted
  // paths + expected RMUX version — never an empty resolution snapshot.
  const dir = mkdtempSync(join(tmpdir(), "relay-term-fail-"));
  dirs.push(dir);
  const bridgeDir = mkdtempSync(join(tmpdir(), "relay-term-bridge-"));
  dirs.push(bridgeDir);
  const failingBridge = join(bridgeDir, "xacpx-rmux-bridge");
  writeFileSync(failingBridge, "#!/bin/sh\necho 'not-a-sidecar-response'\nexit 1\n");
  chmodSync(failingBridge, 0o755);

  const errorEvents: Array<[string, unknown]> = [];
  const channel = new RelayChannel(
    {
      url: "ws://h:1",
      pairingToken: "t",
      terminal: { enabled: true, bridgeCommand: failingBridge },
    },
    {
      credentialStore: new MemoryCredentialStore(),
      terminalRegistryDir: dir,
      createClient: (opts) => ({ start: () => {}, stop: () => {}, sendEvent: () => {} }),
    },
  );
  const controller = new AbortController();
  const { input } = makeStartInput({
    abortSignal: controller.signal,
    sessionResources: new FakeCatalog(),
    logger: {
      info: async () => {},
      debug: async () => {},
      error: async (event: string, _message: string, fields: unknown) => {
        errorEvents.push([event, fields]);
      },
    },
  });

  const started = channel.start(input as never);
  void started;
  const deadline = Date.now() + 5000;
  while (
    !errorEvents.some(([event]) => event === "relay.terminal_bootstrap_failed") &&
    Date.now() < deadline
  ) {
    await Bun.sleep(5);
  }
  const failed = errorEvents.find(([event]) => event === "relay.terminal_bootstrap_failed");
  expect(failed, "bootstrap failure must be logged").toBeDefined();
  const fields = (failed![1] ?? {}) as Record<string, string>;
  expect(fields.bridgeSource).toBe("config");
  expect(fields.bridgePath).toContain("xacpx-rmux-bridge");
  // Paths must be redacted for doctor/logs: never the full absolute path.
  expect(fields.bridgePath).not.toBe(failingBridge);
  expect(fields.bridgePath ?? "").not.toContain(tmpdir());
  expect(fields.rmuxExpectedVersion).toBe("0.10.0");
});
