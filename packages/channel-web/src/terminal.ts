import { homedir } from "node:os";
import { join } from "node:path";

import {
  MAX_TERMINAL_INPUT_BYTES,
  MSG,
  RELAY_CAPABILITIES,
  decodeEnvelope,
  parseCanonicalBase64,
  type WebClientMessage,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";
import type { SessionResourceCatalog } from "xacpx/plugin-api";

import {
  DefaultRelayTerminalRuntime,
  RmuxSidecarSupervisor,
  SupervisedRmuxDriver,
  TerminalRegistryStore,
  missingRequiredRmuxBridgeCapabilities,
  parseRelayTerminalConfig,
  type RmuxTerminalDriver,
  type TerminalViewerEvent,
} from "@ganglion/xacpx-channel-relay/terminal";

import { LOCAL_INSTANCE_ID } from "./config.js";

const LOCAL_CHAT_KEY = "web:local";

export interface LocalTerminalClient {
  ready: boolean;
  handle(message: WebClientMessage, viewerId: string, send: (event: WebServerEvent, done?: (error?: Error) => void) => void): Promise<void>;
  detachViewer(viewerId: string): void;
}

interface Binding {
  viewerId: string;
  attachmentId: string;
  terminalId: string;
  send: (event: WebServerEvent, done?: (error?: Error) => void) => void;
}

export class LocalTerminal {
  private runtime: DefaultRelayTerminalRuntime | null = null;
  private supervisor: RmuxSidecarSupervisor | null = null;
  private readonly bindings = new Map<string, Binding>();
  private readonly closedViewers = new Set<string>();
  private readonly opening = new Map<string, number>();

  constructor(
    private readonly catalog: SessionResourceCatalog,
    // Separate from the relay dashboard's registry, so both can run. Each one
    // then keeps its own terminal process.
    private readonly registryDir = join(homedir(), ".xacpx", "web-terminal"),
    private readonly createDriver?: () => RmuxTerminalDriver,
  ) {}

  async start(): Promise<void> {
    const config = parseRelayTerminalConfig({ enabled: true });
    const registry = new TerminalRegistryStore({ dir: this.registryDir, exclusiveWriter: true });
    let driver: RmuxTerminalDriver;
    if (this.createDriver) {
      driver = this.createDriver();
    } else {
      const supervisor = new RmuxSidecarSupervisor({ config });
      this.supervisor = supervisor;
      driver = new SupervisedRmuxDriver(supervisor);
      await supervisor.start();
    }
    const diagnostics = await driver.diagnostics();
    const missing = missingRequiredRmuxBridgeCapabilities(diagnostics.capabilities);
    if (missing.length > 0) throw new Error(`terminal bridge is missing: ${missing.join(", ")}`);
    const runtime = new DefaultRelayTerminalRuntime({
      registry,
      driver,
      catalog: this.catalog,
      config,
      onViewerEvent: (event, onFlush) => {
        const webEvent = viewerWebEvent(event);
        const binding = this.bindings.get(event.attachmentId);
        if (!webEvent || !binding) {
          onFlush?.();
          return;
        }
        binding.send(webEvent, (error) => onFlush?.(error));
      },
    });
    await runtime.start();
    this.runtime = runtime;
  }

  client(): LocalTerminalClient {
    return {
      ready: this.runtime !== null,
      handle: (message, viewerId, send) => this.handle(message, viewerId, send),
      detachViewer: (viewerId) => this.detachViewer(viewerId),
    };
  }

  detachViewer(viewerId: string): void {
    if ((this.opening.get(viewerId) ?? 0) > 0) this.closedViewers.add(viewerId);
    for (const [attachmentId, binding] of this.bindings) {
      if (binding.viewerId !== viewerId) continue;
      this.runtime?.detach(attachmentId);
      this.bindings.delete(attachmentId);
    }
  }

  capabilities(): string[] {
    return this.runtime
      ? [RELAY_CAPABILITIES.terminalRmuxRecoveryV1, RELAY_CAPABILITIES.terminalMultiViewV1]
      : [];
  }

  async stop(): Promise<void> {
    await this.runtime?.stop();
    await this.supervisor?.stop();
    this.runtime = null;
    this.supervisor = null;
    this.bindings.clear();
  }

  private async handle(message: WebClientMessage, viewerId: string, send: (event: WebServerEvent, done?: (error?: Error) => void) => void): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !("instanceId" in message) || message.instanceId !== LOCAL_INSTANCE_ID) return;
    if (message.kind === "terminal-open") {
      await this.open(message, viewerId, send);
      return;
    }
    const binding = "attachmentId" in message ? this.bindings.get(message.attachmentId) : undefined;
    if (binding && binding.viewerId !== viewerId) return;
    try {
      if (message.kind === "terminal-input" && "attachmentId" in message) {
        const data = decodeInput(message.dataBase64);
        if (!data || !binding) return;
        await runtime.input(message.attachmentId, message.generation, data);
      } else if (message.kind === "terminal-resize" && "attachmentId" in message && binding) {
        await runtime.resize(message.attachmentId, message.generation, message.cols, message.rows);
      } else if (message.kind === "terminal-stream-start" && binding) {
        await runtime.startRecovery(message.attachmentId);
      } else if (message.kind === "terminal-heartbeat" && binding) {
        runtime.heartbeat(message.attachmentId);
      } else if (message.kind === "terminal-detach" && binding) {
        runtime.detach(message.attachmentId);
        this.bindings.delete(message.attachmentId);
      } else if (message.kind === "terminal-take-control" && binding) {
        const taken = await runtime.takeControl(message.attachmentId, message.generation);
        send({
          kind: "terminal-opened",
          requestId: message.requestId,
          instanceId: LOCAL_INSTANCE_ID,
          terminalId: taken.terminalId,
          generation: taken.generation,
          attachmentId: taken.attachmentId,
          role: taken.role,
          viewerCount: taken.viewerCount,
        });
      } else if (message.kind === "terminal-resync" && binding) {
        await runtime.resync(message.attachmentId, message.generation);
        send({
          kind: "terminal-request-failed",
          requestId: message.requestId,
          instanceId: LOCAL_INSTANCE_ID,
          code: "ok",
          message: "resync-accepted",
        });
      } else if (message.kind === "terminal-terminate") {
        const ended = await runtime.terminate({
          terminalId: message.terminalId,
          generation: message.generation,
          reason: "explicit-close",
        });
        send({
          kind: "terminal-exit",
          instanceId: LOCAL_INSTANCE_ID,
          terminalId: message.terminalId,
          generation: message.generation,
          reason: ended.status,
        });
        send({
          kind: "terminal-request-failed",
          requestId: message.requestId,
          instanceId: LOCAL_INSTANCE_ID,
          code: ended.status,
          message: ended.status,
        });
      }
    } catch (error) {
      send({
        kind: "terminal-request-failed",
        requestId: "requestId" in message ? message.requestId : "",
        instanceId: LOCAL_INSTANCE_ID,
        code: "terminal-unavailable",
        message: error instanceof Error ? error.message : "terminal request failed",
      });
    }
  }

  private async open(
    message: Extract<WebClientMessage, { kind: "terminal-open" }>,
    viewerId: string,
    send: (event: WebServerEvent) => void,
  ): Promise<void> {
    this.opening.set(viewerId, (this.opening.get(viewerId) ?? 0) + 1);
    try {
      const opened = await this.runtime!.openOrResume({
        chatKey: LOCAL_CHAT_KEY,
        sessionAlias: message.sessionAlias,
        viewerId,
        cols: message.cols,
        rows: message.rows,
      });
      if (this.closedViewers.has(viewerId)) {
        this.runtime?.detach(opened.attachmentId);
        return;
      }
      this.bindings.set(opened.attachmentId, {
        viewerId,
        attachmentId: opened.attachmentId,
        terminalId: opened.terminalId,
        send,
      });
      send({
        kind: "terminal-opened",
        requestId: message.requestId,
        instanceId: LOCAL_INSTANCE_ID,
        terminalId: opened.terminalId,
        generation: opened.generation,
        attachmentId: opened.attachmentId,
        role: opened.role,
        viewerCount: opened.viewerCount,
      });
    } catch (error) {
      send({
        kind: "terminal-request-failed",
        requestId: message.requestId,
        instanceId: LOCAL_INSTANCE_ID,
        code: "terminal-unavailable",
        message: error instanceof Error ? error.message : "terminal did not open",
      });
    } finally {
      const left = (this.opening.get(viewerId) ?? 1) - 1;
      if (left > 0) this.opening.set(viewerId, left);
      else {
        this.opening.delete(viewerId);
        this.closedViewers.delete(viewerId);
      }
    }
  }

}

export function viewerWebEvent(event: TerminalViewerEvent): WebServerEvent | null {
  const base = { instanceId: LOCAL_INSTANCE_ID, attachmentId: event.attachmentId };
  switch (event.type) {
    case "rebase-start":
      return { kind: "terminal-rebase-start", ...base, generation: event.generation, epoch: event.epoch, nextSequence: event.nextSequence, cols: event.cols, rows: event.rows, alternate: event.alternate, totalBytes: event.totalBytes, chunkCount: event.chunkCount };
    case "rebase-chunk":
      return { kind: "terminal-rebase-chunk", ...base, generation: event.generation, epoch: event.epoch, index: event.index, dataBase64: event.dataBase64 };
    case "rebase-end":
      return { kind: "terminal-rebase-end", ...base, generation: event.generation, epoch: event.epoch };
    case "bytes":
      return { kind: "terminal-bytes", ...base, generation: event.generation, epoch: event.epoch, sequence: event.sequence, dataBase64: event.dataBase64 };
    case "role-changed":
      return { kind: "terminal-role-changed", ...base, terminalId: event.terminalId, role: event.role, viewerCount: event.viewerCount };
    case "exit":
      return { kind: "terminal-exit", instanceId: LOCAL_INSTANCE_ID, terminalId: event.terminalId, generation: event.generation, reason: event.reason, ...(event.code !== undefined ? { code: event.code } : {}) };
    case "recovery-failed":
    case "queue-overflow":
      return { kind: "terminal-recovery-failed", ...base, generation: event.generation, code: event.type === "queue-overflow" ? "terminal-recovery-too-large" : event.code, message: event.type === "queue-overflow" ? "attachment outbound queue overflow" : event.message };
    default:
      return null;
  }
}

export function terminalMessage(raw: string): WebClientMessage | null {
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok) return null;
  const payload = decoded.envelope.payload;
  if (!payload || typeof payload !== "object" || !("kind" in payload)) return null;
  const message = payload as WebClientMessage;
  return typeof message.kind === "string" && message.kind.startsWith("terminal-") ? message : null;
}

export function decodeInput(encoded: string): Uint8Array | null {
  return parseCanonicalBase64(encoded, MAX_TERMINAL_INPUT_BYTES);
}

