// A desktop-only channel (terminal.enabled=false, desktop.enabled=true) must
// still reach the tunnel runtime with a logger. The logger used to be captured
// inside the terminal bootstrap, which returns early when terminal is disabled,
// so the most common "terminal off, desktop on" configuration had probe and
// tunnel events silently dropped.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RELAY_CAPABILITIES } from "../../../../packages/relay-protocol/src/index";
import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(_c: RelayCredential) {}
  clear() { this.value = null; }
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

test("a desktop-only channel still hands the tunnel runtime a logger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-desktop-chan-"));
  dirs.push(dir);

  let capturedCaps: string[] | undefined;
  const fakeClient = { start: () => {}, stop: () => {}, sendEvent: () => {} };
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t", terminal: { enabled: false }, desktop: { enabled: true } },
    {
      credentialStore: new MemoryCredentialStore(),
      terminalRegistryDir: dir,
      // No terminal driver: the terminal path must not be entered at all.
      createClient: (opts) => { capturedCaps = opts.capabilities; return fakeClient as never; },
    },
  );

  const started = channel.start({
    agent: { chat: async () => ({ text: "" }) },
    abortSignal: new AbortController().signal,
    quota: {} as never,
    logger: { info: async () => {}, error: async () => {}, debug: async () => {} },
    control: {
      events: { subscribe: () => () => {} },
      listSessions: () => [],
    },
    coreVersion: "0.17.0",
  } as never);
  started.catch(() => {});
  // start() awaits the terminal bootstrap and then wires an outbound client that
  // never settles here, so poll for the runtime the way the terminal test polls
  // for capabilities.
  const deadline = Date.now() + 2000;
  let desktop = channel.getDesktopRuntimeForTests();
  while (desktop === null && Date.now() < deadline) {
    await Bun.sleep(5);
    desktop = channel.getDesktopRuntimeForTests();
  }

  expect(desktop).not.toBeNull();
  // The assertion the previous wiring failed: inspect the injected logger.
  const runtimeLogger = (desktop as unknown as { deps: { logger?: unknown } }).deps.logger;
  expect(runtimeLogger).toBeDefined();
  expect(typeof (runtimeLogger as { info?: unknown }).info).toBe("function");
  expect(typeof (runtimeLogger as { error?: unknown }).error).toBe("function");
  void capturedCaps;
});
