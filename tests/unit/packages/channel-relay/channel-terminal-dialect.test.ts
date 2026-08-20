import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";
import { InMemoryRmuxDriver } from "../../../../packages/channel-relay/src/terminal/in-memory-rmux-driver";
import {
  RMUX_BRIDGE_MULTI_VIEW_CAPABILITY,
  RMUX_BRIDGE_RECOVERY_CAPABILITY,
  RMUX_POSIX_XTERM_DIALECT_CAPABILITY,
  requiredRmuxBridgeCapabilities,
} from "../../../../packages/channel-relay/src/terminal/rmux-driver";
import type {
  SessionResourceCatalog,
  SessionResourceDescriptor,
  SessionResourceLifecycleEvent,
} from "xacpx/plugin-api";

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() {
    return this.value;
  }
  save(credential: RelayCredential) {
    this.value = credential;
  }
  clear() {
    this.value = null;
  }
}

class FakeCatalog implements SessionResourceCatalog {
  private readonly listeners = new Set<
    (event: SessionResourceLifecycleEvent) => void
  >();
  private readonly item: SessionResourceDescriptor = {
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    channelId: "relay",
    internalAlias: "demo",
    displayAlias: "demo",
    workspace: "ws",
    cwd: "/tmp/ws",
    archived: false,
  };

  async resolve(_channelId: string, alias: string) {
    return alias === this.item.displayAlias ? this.item : null;
  }

  async list(channelId: string) {
    return channelId === this.item.channelId ? [this.item] : [];
  }

  subscribe(listener: (event: SessionResourceLifecycleEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function waitUntil(
  pred: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  if (!pred()) throw new Error(`timed out waiting for ${label}`);
}

test("bridge capability contract requires xterm dialect on POSIX but not Windows", () => {
  expect(requiredRmuxBridgeCapabilities("linux")).toContain(
    RMUX_POSIX_XTERM_DIALECT_CAPABILITY,
  );
  expect(requiredRmuxBridgeCapabilities("darwin")).toContain(
    RMUX_POSIX_XTERM_DIALECT_CAPABILITY,
  );
  expect(requiredRmuxBridgeCapabilities("win32")).not.toContain(
    RMUX_POSIX_XTERM_DIALECT_CAPABILITY,
  );
  expect(requiredRmuxBridgeCapabilities("win32")).toEqual([
    RMUX_BRIDGE_RECOVERY_CAPABILITY,
    RMUX_BRIDGE_MULTI_VIEW_CAPABILITY,
  ]);
});

test("in-memory driver advertises the host bridge contract by default", async () => {
  const diagnostics = await new InMemoryRmuxDriver().diagnostics();
  expect(diagnostics.capabilities).toEqual(requiredRmuxBridgeCapabilities());
});

test.skipIf(process.platform === "win32")(
  "old bridge without POSIX dialect fails closed before reconcile or Hub capability publication",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-term-dialect-"));
    dirs.push(dir);

    const driver = new InMemoryRmuxDriver();
    driver.setDiagnostics({
      bridgeVersion: "0.1.0-old",
      capabilities: [
        RMUX_BRIDGE_RECOVERY_CAPABILITY,
        RMUX_BRIDGE_MULTI_VIEW_CAPABILITY,
      ],
    });

    let listCalls = 0;
    const originalList = driver.list.bind(driver);
    driver.list = async () => {
      listCalls += 1;
      return originalList();
    };

    let capturedCaps: string[] | undefined;
    const errors: string[] = [];
    const channel = new RelayChannel(
      {
        url: "ws://h:1",
        pairingToken: "t",
        terminal: { enabled: true },
      },
      {
        credentialStore: new MemoryCredentialStore(),
        terminalRegistryDir: dir,
        createTerminalDriver: () => driver,
        createClient: (options) => {
          capturedCaps = options.capabilities;
          return {
            start: () => {},
            stop: () => {},
            sendEvent: () => {},
          } as never;
        },
      },
    );

    const controller = new AbortController();
    const started = channel.start({
      agent: { chat: async () => ({ text: "" }) },
      abortSignal: controller.signal,
      quota: {} as never,
      logger: {
        info: async () => {},
        debug: async () => {},
        error: async (_id: string, message: string) => {
          errors.push(message);
        },
      },
      control: {
        events: { subscribe: () => () => {} },
        listSessions: () => [],
      },
      coreVersion: "0.17.0",
      sessionResources: new FakeCatalog(),
    } as never);

    await waitUntil(() => capturedCaps !== undefined, "client capability capture");
    expect(capturedCaps).toEqual([]);
    expect(channel.getTerminalRuntimeForTests()).toBeNull();
    expect(listCalls).toBe(0);
    expect(
      errors.some((message) =>
        message.includes(RMUX_POSIX_XTERM_DIALECT_CAPABILITY),
      ),
    ).toBe(true);

    controller.abort();
    await started;
  },
);
