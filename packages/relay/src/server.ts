import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { serve, type ServerType } from "@hono/node-server";
import { WebSocketServer } from "ws";

import {
  MSG, type ControlEventDto, type InstanceEventPayload, type InstanceNoticePayload, type LiveTurnSnapshotDto, type RelayEnvelope, type ToolStepDto, type TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";

import { createSqlDriver, initSchema, type SqlDriver } from "./db.js";
import { AccountStore } from "./stores/accounts.js";
import { InstanceStore } from "./stores/instances.js";
import { MessageStore } from "./stores/messages.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, InstanceGateway } from "./gateway/instance-gateway.js";
import { WebGateway } from "./gateway/web-gateway.js";
import { createApp } from "./http/app.js";
import { startMaintenanceLoop } from "./maintenance.js";

const MAX_MESSAGES_PER_SESSION = 2000;
const MAX_TOOL_STEPS = 200;
const REASONING_CAP = 16000;

export interface RelayRuntime {
  db: SqlDriver;
  accounts: AccountStore;
  instances: InstanceStore;
  messages: MessageStore;
  gateway: InstanceGateway;
  webGateway: WebGateway;
  app: ReturnType<typeof createApp>;
  close(): void;
}

export interface CreateRuntimeOptions {
  webRoot?: string;
  historyRetentionDays?: number;
  requestTimeoutMs?: number;
  trustProxy?: boolean;
}

/** Testable assembly without any network listener. */
export async function createRelayRuntime(dbPath: string, options: CreateRuntimeOptions = {}): Promise<RelayRuntime> {
  const db = await createSqlDriver(dbPath);
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const messages = new MessageStore(db);
  const webGateway = new WebGateway();

  // Accumulate streaming turn state per (instance, session); flush to history on finish.
  // `parts` records text / reasoning / tool events in arrival order so the web can
  // replay history inline (same model the live view builds). `steps`/`reasoning`/`text`
  // remain for the flat fallback + the persisted `text` column.
  interface TurnAccumulator { text: string; steps: Map<string, ToolStepDto>; reasoning: string; parts: TurnPartDto[]; startedAt: number }
  const turnBuffers = new Map<string, TurnAccumulator>();
  const key = (instanceId: string, alias: string) => `${instanceId}\0${alias}`;
  // Snapshot the in-flight turns for one instance so a (re)connecting web client can
  // rebuild the live view after a refresh (see GET /api/active-turns). `parts` is the
  // live array — fine to hand out by reference since the route serializes it at once.
  const listActiveTurns = (instanceId: string): LiveTurnSnapshotDto[] => {
    const prefix = `${instanceId}\0`;
    const out: LiveTurnSnapshotDto[] = [];
    for (const [k, a] of turnBuffers) {
      if (!k.startsWith(prefix)) continue;
      out.push({
        instanceId,
        sessionAlias: k.slice(prefix.length),
        parts: a.parts,
        status: a.text ? "streaming" : "working",
        startedAt: a.startedAt,
      });
    }
    return out;
  };
  // Coalescing appenders — consecutive same-type chunks merge into one part.
  const pushTextPart = (a: TurnAccumulator, chunk: string) => {
    const last = a.parts[a.parts.length - 1];
    if (last?.type === "text") last.text += chunk;
    else a.parts.push({ type: "text", text: chunk });
  };
  const pushReasoningPart = (a: TurnAccumulator, chunk: string) => {
    const last = a.parts[a.parts.length - 1];
    if (last?.type === "reasoning") last.text = (last.text + chunk).slice(0, REASONING_CAP);
    else a.parts.push({ type: "reasoning", text: chunk.slice(0, REASONING_CAP) });
  };
  const pushToolPart = (a: TurnAccumulator, step: ToolStepDto) => {
    const i = a.parts.findIndex((p) => p.type === "tool" && p.step.toolCallId === step.toolCallId);
    if (i >= 0) (a.parts[i] as Extract<TurnPartDto, { type: "tool" }>).step = step;
    else a.parts.push({ type: "tool", step });
  };

  const gateway = new InstanceGateway({
    instances,
    accounts,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    onStatusChange: (instanceId, accountId, online) => {
      if (!online) {
        const prefix = `${instanceId}\0`;
        for (const k of turnBuffers.keys()) if (k.startsWith(prefix)) turnBuffers.delete(k);
      }
      webGateway.broadcast(accountId, { kind: "instance-status", instanceId, online });
    },
    onEvent: (instanceId, accountId, envelope: RelayEnvelope) => {
      if (envelope.type === MSG.instanceEvent) {
        const event = (envelope.payload as InstanceEventPayload).event as ControlEventDto;
        webGateway.broadcast(accountId, { kind: "control-event", instanceId, event });
        if (event.type === "turn-started") {
          turnBuffers.set(key(instanceId, event.sessionAlias), { text: "", steps: new Map(), reasoning: "", parts: [], startedAt: Date.now() });
          // A scheduled-origin turn carries its prompt here (a normal web turn persists
          // its inbound message via the prompt RPC instead). Persist it so the fired
          // task's prompt shows in history, not just the agent's out-of-context reply.
          if (event.prompt) messages.append(instanceId, event.sessionAlias, "in", event.prompt, event.scheduled ? { scheduled: event.scheduled } : undefined);
        } else if (event.type === "turn-output") {
          // Only append to an existing buffer; never lazily resurrect one. A buffer
          // is created solely by turn-started, so a stray streaming event arriving
          // after an offline sweep (or with no turn-started) is dropped instead of
          // leaking a buffer that no turn-finished will ever clear.
          const a = turnBuffers.get(key(instanceId, event.sessionAlias));
          if (a) { a.text += event.chunk; pushTextPart(a, event.chunk); }
        } else if (event.type === "tool-event") {
          const a = turnBuffers.get(key(instanceId, event.sessionAlias));
          if (a && (a.steps.has(event.step.toolCallId) || a.steps.size < MAX_TOOL_STEPS)) {
            a.steps.set(event.step.toolCallId, event.step);
            pushToolPart(a, event.step);
          }
        } else if (event.type === "turn-thought") {
          const a = turnBuffers.get(key(instanceId, event.sessionAlias));
          if (a) { a.reasoning = (a.reasoning + event.chunk).slice(0, REASONING_CAP); pushReasoningPart(a, event.chunk); }
        } else if (event.type === "turn-finished") {
          const k = key(instanceId, event.sessionAlias);
          const a = turnBuffers.get(k);
          turnBuffers.delete(k);
          if (!a) return;
          const steps = [...a.steps.values()];
          const hasStructured = steps.length > 0 || a.reasoning.length > 0;
          if (a.text || hasStructured) {
            const structured = hasStructured
              ? { toolSteps: steps, ...(a.reasoning ? { reasoning: a.reasoning } : {}), ...(a.parts.length ? { parts: a.parts } : {}) }
              : undefined;
            messages.append(instanceId, event.sessionAlias, "out", a.text, structured);
          }
        } else if (event.type === "session-history") {
          // Seed a freshly-attached native session's recovered prior conversation into
          // history (one-time). Guard against re-seeding an already-populated session so a
          // redelivered event can't duplicate the backlog.
          const existing = messages.listBySession(accountId, instanceId, event.sessionAlias, { limit: 1 });
          if (existing.messages.length === 0) {
            for (const row of event.messages) {
              messages.append(instanceId, event.sessionAlias, row.direction, row.text, row.structured);
            }
          }
        }
      } else if (envelope.type === MSG.instanceNotice) {
        webGateway.broadcast(accountId, { kind: "notice", instanceId, notice: envelope.payload as InstanceNoticePayload });
      }
    },
  });

  const app = createApp({
    accounts, instances, messages, gateway, webRoot: options.webRoot,
    historyRetentionDays: options.historyRetentionDays ?? 30,
    maxMessagesPerSession: MAX_MESSAGES_PER_SESSION,
    activeTurns: listActiveTurns,
    trustProxy: options.trustProxy,
  });
  return { db, accounts, instances, messages, gateway, webGateway, app, close: () => db.close() };
}

export interface StartRelayOptions {
  dbPath: string;
  httpPort: number;
  /**
   * Dedicated instance-gateway port (legacy two-port layout). Omit (default) to
   * merge the gateway onto the HTTP port: connectors then reach it via a WS
   * upgrade at `/` or `/gateway`, so a single port + domain serves everything.
   */
  wsPort?: number;
  host?: string;
  webRoot?: string;
  historyRetentionDays?: number;
  requestTimeoutMs?: number;
  trustProxy?: boolean;
}

export interface RunningRelay {
  runtime: RelayRuntime;
  httpPort: number;
  /** The dedicated gateway port, or `null` when the gateway is merged onto the HTTP port. */
  wsPort: number | null;
  close(): Promise<void>;
}

export async function startRelayServer(options: StartRelayOptions): Promise<RunningRelay> {
  const runtime = await createRelayRuntime(options.dbPath, {
    webRoot: options.webRoot,
    historyRetentionDays: options.historyRetentionDays,
    requestTimeoutMs: options.requestTimeoutMs,
    trustProxy: options.trustProxy,
  });
  const host = options.host ?? "0.0.0.0";

  const retention = { historyRetentionDays: options.historyRetentionDays ?? 30, maxPerSession: MAX_MESSAGES_PER_SESSION };
  const stopMaintenance = startMaintenanceLoop(
    { accounts: runtime.accounts, instances: runtime.instances, messages: runtime.messages },
    retention,
    60 * 60 * 1000,
  );

  // serve() returns the server synchronously; listeningListener fires when bound.
  const httpServer: ServerType = await new Promise((resolve, reject) => {
    let server: ServerType;
    try {
      server = serve(
        { fetch: runtime.app.fetch, port: options.httpPort, hostname: host },
        () => resolve(server),
      );
    } catch (err) {
      reject(err);
    }
  });

  // Default (merged): the instance gateway shares the HTTP port, handled as a
  // noServer WS upgrade alongside the dashboard's `/ws`. Passing `wsPort` opts
  // into the legacy dedicated-port layout (e.g. to firewall the gateway apart).
  const dedicated = options.wsPort !== undefined;
  let wss: WebSocketServer | undefined;
  let gatewayWss: WebSocketServer | undefined;
  if (dedicated) {
    wss = new WebSocketServer({ port: options.wsPort, host });
    await new Promise<void>((resolve) => wss!.on("listening", () => resolve()));
    wss.on("connection", (socket) => runtime.gateway.handleConnection(socket));
  } else {
    gatewayWss = new WebSocketServer({ noServer: true });
  }

  const webWss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/ws") {
      const token = parseCookie(req.headers.cookie ?? "")["xrelay_session"];
      const account = token ? runtime.accounts.getSessionAccount(token) : null;
      if (!account) { socket.destroy(); return; }
      webWss.handleUpgrade(req, socket, head, (ws) => runtime.webGateway.register(account.id, ws));
      return;
    }
    // Merged gateway: connectors dial the bare host (root) or an explicit
    // `/gateway`. Auth is the gateway's own token/credential handshake, so no
    // cookie gate here. In dedicated mode `gatewayWss` is undefined → reject.
    if (gatewayWss && (path === "/" || path === "/gateway" || path.startsWith("/gateway/"))) {
      gatewayWss.handleUpgrade(req, socket, head, (ws) => runtime.gateway.handleConnection(ws));
      return;
    }
    socket.destroy();
  });

  const httpPort = (httpServer.address() as { port: number }).port;
  const wsPort = wss ? (wss.address() as { port: number }).port : null;
  return {
    runtime,
    httpPort,
    wsPort,
    close: async () => {
      stopMaintenance();
      await new Promise<void>((resolve) => webWss.close(() => resolve()));
      if (gatewayWss) await new Promise<void>((resolve) => gatewayWss!.close(() => resolve()));
      if (wss) await new Promise<void>((resolve) => wss!.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      runtime.close();
    },
  };
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
