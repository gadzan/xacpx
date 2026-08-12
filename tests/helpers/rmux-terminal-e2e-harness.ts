/**
 * Connector ↔ hub ↔ browser RMUX terminal harness for Task 25.
 * Real protocol envelopes + request correlation; RMUX replaced by InMemoryRmuxDriver.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import {
  decodeEnvelope,
  encodeEnvelope,
  parseWebServerEvent,
  webClientEnvelope,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";
import type {
  SessionResourceCatalog,
  SessionResourceDescriptor,
  SessionResourceLifecycleEvent,
} from "xacpx/plugin-api";

import { RelayChannel } from "../../packages/channel-relay/src/channel";
import { CredentialStore } from "../../packages/channel-relay/src/credential-store";
import { RelayClient } from "../../packages/channel-relay/src/relay-client";
import { InMemoryRmuxDriver } from "../../packages/channel-relay/src/terminal/in-memory-rmux-driver";
import { TerminalRegistryStore } from "../../packages/channel-relay/src/terminal/terminal-registry-store";
import { startRelayServer, type RunningRelay } from "../../packages/relay/src/server";

export class MutableCatalog implements SessionResourceCatalog {
  private readonly listeners = new Set<(e: SessionResourceLifecycleEvent) => void>();

  constructor(private rows: SessionResourceDescriptor[] = []) {}

  async resolve(_channelId: string, alias: string) {
    return this.rows.find((r) => r.displayAlias === alias && !r.archived) ?? null;
  }

  async list(channelId: string) {
    return this.rows.filter((r) => r.channelId === channelId);
  }

  subscribe(listener: (e: SessionResourceLifecycleEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setRows(rows: SessionResourceDescriptor[]) {
    this.rows = rows;
  }

  emit(event: SessionResourceLifecycleEvent) {
    for (const l of this.listeners) l(event);
  }

  replaceAlias(oldLogicalId: string, next: SessionResourceDescriptor) {
    this.rows = this.rows.filter((r) => r.logicalSessionId !== oldLogicalId);
    this.rows.push(next);
  }
}

export function demoDescriptor(
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

export interface BrowserSession {
  ws: WebSocket;
  events: WebServerEvent[];
  waitFor: (
    pred: (e: WebServerEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<WebServerEvent>;
  /** Wait for a NEW event after the current high-water mark. */
  waitForNext: (
    pred: (e: WebServerEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<WebServerEvent>;
  send: (msg: Parameters<typeof webClientEnvelope>[0]) => void;
  close: () => void;
}

export interface OpenedTerminal {
  requestId: string;
  terminalId: string;
  generation: string;
  attachmentId: string;
  role: "controller" | "spectator";
  viewerCount: number;
}

export interface RmuxTerminalE2EHarness {
  relay: RunningRelay;
  channel: RelayChannel;
  driver: InMemoryRmuxDriver;
  catalog: MutableCatalog;
  registryDir: string;
  accountId: string;
  instanceId: string;
  cookie: string;
  connectBrowser: () => Promise<BrowserSession>;
  openTerminal: (
    browser: BrowserSession,
    opts?: { sessionAlias?: string; cols?: number; rows?: number; requestId?: string },
  ) => Promise<OpenedTerminal | { failed: WebServerEvent }>;
  streamStart: (browser: BrowserSession, attachmentId: string, requestId?: string) => void;
  terminate: (
    browser: BrowserSession,
    terminalId: string,
    generation: string,
    requestId?: string,
  ) => Promise<WebServerEvent>;
  takeControl: (
    browser: BrowserSession,
    attachmentId: string,
    generation: string,
    requestId?: string,
  ) => Promise<WebServerEvent>;
  detach: (browser: BrowserSession, attachmentId: string) => void;
  registrySnapshot: () => Promise<ReturnType<TerminalRegistryStore["getSnapshot"]>>;
  messageCount: (sessionAlias?: string) => number;
  waitUntilOnline: (timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export async function createRmuxTerminalE2EHarness(opts: {
  terminal?: Record<string, unknown>;
  descriptors?: SessionResourceDescriptor[];
} = {}): Promise<RmuxTerminalE2EHarness> {
  const workDir = mkdtempSync(join(tmpdir(), "rmux-e2e-"));
  const registryDir = join(workDir, "registry");
  const credentialPath = join(workDir, "credential.json");

  const relay = await startRelayServer({
    dbPath: ":memory:",
    httpPort: 0,
    host: "127.0.0.1",
  });

  const admin = relay.runtime.accounts.createAccount("admin");
  const { token: loginToken } = relay.runtime.accounts.createLoginToken(admin.id);
  const loginRes = await relay.runtime.app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: loginToken }),
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  const tokenRes = await relay.runtime.app.request("/api/instances/pairing-token", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "e2e-pc" }),
  });
  const { token: pairingToken } = (await tokenRes.json()) as { token: string };

  const driver = new InMemoryRmuxDriver();
  const catalog = new MutableCatalog(opts.descriptors ?? [demoDescriptor()]);
  const credentialStore = new CredentialStore(credentialPath);

  const channel = new RelayChannel(
    {
      url: `ws://127.0.0.1:${relay.httpPort}/gateway`,
      pairingToken,
      terminal: { enabled: true, ...(opts.terminal ?? {}) },
    },
    {
      credentialStore,
      terminalRegistryDir: registryDir,
      createTerminalDriver: () => driver,
      createClient: (clientOpts) =>
        new RelayClient({
          ...clientOpts,
          reconnectDelaysMs: [0, 10, 50, 100],
        }),
    },
  );

  const abort = new AbortController();
  const control = {
    events: { subscribe: () => () => {} },
    listSessions: () => [],
    listScheduledTasks: () => [],
    listOrchestrationTasks: () => [],
    runScheduledTurn: async () => ({ ok: true as const }),
  };

  const started = channel.start({
    abortSignal: abort.signal,
    coreVersion: "0.17.0",
    control: control as never,
    sessionResources: catalog,
    agent: { chat: async () => ({ text: "" }) },
    quota: {} as never,
    logger: {
      info: async () => {},
      error: async () => {},
      debug: async () => {},
    },
  } as never);

  async function waitUntilOnline(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const listRes = await relay.runtime.app.request("/api/instances", { headers: { cookie } });
      const body = (await listRes.json()) as { instances: Array<{ id: string; online: boolean }> };
      const inst = body.instances[0];
      if (inst?.online) {
        harness.instanceId = inst.id;
        return;
      }
      await Bun.sleep(20);
    }
    throw new Error("connector did not come online");
  }

  const browsers: BrowserSession[] = [];

  const harness: RmuxTerminalE2EHarness = {
    relay,
    channel,
    driver,
    catalog,
    registryDir,
    accountId: admin.id,
    instanceId: "",
    cookie,
    async connectBrowser() {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.httpPort}/ws`, {
        headers: { cookie },
      });
      const events: WebServerEvent[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.on("message", (data) => {
        const decoded = decodeEnvelope(String(data));
        if (!decoded.ok) return;
        const event = parseWebServerEvent(decoded.envelope);
        if (event) events.push(event);
      });
      const browser: BrowserSession = {
        ws,
        events,
        async waitFor(pred, timeoutMs = 5000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const hit = events.find(pred);
            if (hit) return hit;
            await Bun.sleep(10);
          }
          throw new Error(`waitFor timeout; last events=${JSON.stringify(events.slice(-5))}`);
        },
        async waitForNext(pred, timeoutMs = 5000) {
          const from = events.length;
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const hit = events.slice(from).find(pred);
            if (hit) return hit;
            await Bun.sleep(10);
          }
          throw new Error(`waitForNext timeout; last events=${JSON.stringify(events.slice(-5))}`);
        },
        send(msg) {
          ws.send(encodeEnvelope(webClientEnvelope(msg)));
        },
        close() {
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
      };
      browsers.push(browser);
      browser.send({ kind: "subscribe", instanceIds: [harness.instanceId] });
      await browser.waitFor((e) => e.kind === "state-snapshot");
      return browser;
    },
    async openTerminal(browser, openOpts = {}) {
      const requestId = openOpts.requestId ?? `open-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      browser.send({
        kind: "terminal-open",
        requestId,
        instanceId: harness.instanceId,
        sessionAlias: openOpts.sessionAlias ?? "demo",
        cols: openOpts.cols ?? 80,
        rows: openOpts.rows ?? 24,
      });
      const event = await browser.waitFor(
        (e) =>
          (e.kind === "terminal-opened" || e.kind === "terminal-request-failed") &&
          e.requestId === requestId,
      );
      if (event.kind === "terminal-request-failed") return { failed: event };
      return {
        requestId,
        terminalId: event.terminalId,
        generation: event.generation,
        attachmentId: event.attachmentId,
        role: event.role,
        viewerCount: event.viewerCount,
      };
    },
    streamStart(browser, attachmentId, requestId = `stream-${Date.now()}`) {
      browser.send({
        kind: "terminal-stream-start",
        requestId,
        instanceId: harness.instanceId,
        attachmentId,
      });
    },
    async terminate(browser, terminalId, generation, requestId = `term-${Date.now()}`) {
      browser.send({
        kind: "terminal-terminate",
        requestId,
        instanceId: harness.instanceId,
        terminalId,
        generation,
      });
      return browser.waitFor(
        (e) =>
          e.kind === "terminal-request-failed" &&
          e.requestId === requestId,
      );
    },
    async takeControl(browser, attachmentId, generation, requestId = `tc-${Date.now()}`) {
      browser.send({
        kind: "terminal-take-control",
        requestId,
        instanceId: harness.instanceId,
        attachmentId,
        generation,
      });
      return browser.waitFor(
        (e) =>
          (e.kind === "terminal-opened" || e.kind === "terminal-request-failed") &&
          "requestId" in e &&
          e.requestId === requestId,
      );
    },
    detach(browser, attachmentId) {
      browser.send({
        kind: "terminal-detach",
        instanceId: harness.instanceId,
        attachmentId,
      });
    },
    async registrySnapshot() {
      const store = new TerminalRegistryStore({ dir: registryDir });
      await store.load();
      return store.getSnapshot();
    },
    messageCount(sessionAlias = "demo") {
      return relay.runtime.messages.listBySession(admin.id, harness.instanceId, sessionAlias, {
        limit: 100,
      }).messages.length;
    },
    waitUntilOnline,
    async close() {
      for (const b of browsers) b.close();
      browsers.length = 0;
      abort.abort();
      try {
        await Promise.race([started, Bun.sleep(2000)]);
      } catch {
        // ignore
      }
      await relay.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };

  await waitUntilOnline();
  return harness;
}

export { b64 };
