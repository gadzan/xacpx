// In-process mock of the XACPX Hub used by Playwright E2E.
//
// Serves the REST surface the dashboard needs to boot (login / me / instances /
// control RPC) and a /ws that speaks the real relay-protocol envelope. Terminal
// recovery is driven here: open → opened → rebase-start/end, late rebase,
// spectator vs controller resize, take-control, and WS drop/reconnect.
//
// This is NOT a Web Share socket. It stays on the XACPX Hub protocol so the
// browser under test exercises the same TerminalTab / store / adapter path as
// production.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  decodeEnvelope,
  encodeEnvelope,
  parseWebClientMessage,
  webEventEnvelope,
  type WebClientMessage,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";

export const INSTANCE_ID = "i1";
export const SESSION_ALIAS = "demo";
export const TERMINAL_ID = "term-e2e";
export const GENERATION = "gen-e2e";
export const ATTACHMENT_ID = "att-e2e";

const CAPS = ["terminal.rmux.recovery.v1", "terminal.multi-view.v1"];

export interface MockHub {
  port: number;
  url: string;
  resizes: Array<{ cols: number; rows: number }>;
  inputs: string[];
  lastOpen: { cols: number; rows: number; requestId: string } | null;
  lastTakeControl: { requestId: string } | null;
  sockets: WebSocket[];
  role: "controller" | "spectator";
  send(event: WebServerEvent): void;
  sendRebase(cols: number, rows: number, keyframe?: string, epoch?: number): void;
  closeSockets(): void;
  setRole(role: "controller" | "spectator"): void;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "true",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function canonicalBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export async function startMockHub(): Promise<MockHub> {
  const sockets: WebSocket[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const inputs: string[] = [];
  let lastOpen: MockHub["lastOpen"] = null;
  let lastTakeControl: MockHub["lastTakeControl"] = null;
  let role: "controller" | "spectator" = "controller";
  let rebaseEpoch = 1;

  const http = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      });
      res.end();
      return;
    }
    if (req.method === "POST" && path === "/api/login") {
      json(res, 200, { username: "e2e" });
      return;
    }
    if (req.method === "GET" && path === "/api/me") {
      json(res, 200, { username: "e2e" });
      return;
    }
    if (req.method === "GET" && path === "/api/instances") {
      json(res, 200, {
        instances: [{
          id: INSTANCE_ID,
          name: "e2e-pc",
          online: true,
          lastSeenAt: null,
          capabilities: CAPS,
        }],
      });
      return;
    }
    if (req.method === "POST" && path === `/api/instances/${INSTANCE_ID}/rpc`) {
      const raw = await readBody(req);
      let type = "";
      try { type = (JSON.parse(raw) as { type?: string }).type ?? ""; } catch { /* ignore */ }
      if (type === "control.sessions.list") {
        json(res, 200, {
          result: {
            sessions: [{
              alias: SESSION_ALIAS,
              agent: "codex",
              workspace: "/w",
              transportSession: "t1",
              running: true,
              archived: false,
            }],
            hasMore: false,
            nextOffset: 1,
          },
        });
        return;
      }
      if (type === "control.agents.list") {
        json(res, 200, { result: { agents: [{ name: "codex", driver: "codex" }] } });
        return;
      }
      json(res, 200, { result: {} });
      return;
    }
    json(res, 404, { error: "not-found" });
  });

  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  function send(event: WebServerEvent): void {
    const line = encodeEnvelope(webEventEnvelope(event));
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(line);
    }
  }

  function sendRebase(cols: number, rows: number, keyframe = "", epoch = rebaseEpoch++): void {
    const dataBase64 = canonicalBase64(keyframe);
    const totalBytes = Buffer.from(dataBase64, "base64").byteLength;
    send({
      kind: "terminal-rebase-start",
      instanceId: INSTANCE_ID,
      attachmentId: ATTACHMENT_ID,
      generation: GENERATION,
      epoch,
      nextSequence: 0,
      cols,
      rows,
      alternate: false,
      totalBytes,
      chunkCount: totalBytes === 0 ? 0 : 1,
    });
    if (totalBytes > 0) {
      send({
        kind: "terminal-rebase-chunk",
        instanceId: INSTANCE_ID,
        attachmentId: ATTACHMENT_ID,
        generation: GENERATION,
        epoch,
        index: 0,
        dataBase64,
      });
    }
    send({
      kind: "terminal-rebase-end",
      instanceId: INSTANCE_ID,
      attachmentId: ATTACHMENT_ID,
      generation: GENERATION,
      epoch,
    });
  }

  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (data) => {
      const decoded = decodeEnvelope(String(data));
      if (!decoded.ok) return;
      const msg = parseWebClientMessage(decoded.envelope);
      if (!msg) return;
      handleClient(msg);
    });
    ws.on("close", () => {
      const i = sockets.indexOf(ws);
      if (i >= 0) sockets.splice(i, 1);
    });
  });

  function handleClient(msg: WebClientMessage): void {
    if (msg.kind === "terminal-open") {
      lastOpen = { cols: msg.cols, rows: msg.rows, requestId: msg.requestId };
      send({
        kind: "terminal-opened",
        requestId: msg.requestId,
        instanceId: INSTANCE_ID,
        terminalId: TERMINAL_ID,
        generation: GENERATION,
        attachmentId: ATTACHMENT_ID,
        role,
        viewerCount: role === "spectator" ? 2 : 1,
      });
      // Authoritative recovery geometry first; the browser must then re-fit
      // the host (the late-rebase / initial-viewport invariant).
      sendRebase(80, 24);
      return;
    }
    if (msg.kind === "terminal-take-control") {
      lastTakeControl = { requestId: msg.requestId };
      role = "controller";
      send({
        kind: "terminal-opened",
        requestId: msg.requestId,
        instanceId: INSTANCE_ID,
        terminalId: TERMINAL_ID,
        generation: GENERATION,
        attachmentId: ATTACHMENT_ID,
        role: "controller",
        viewerCount: 1,
      });
      return;
    }
    if (msg.kind === "terminal-resize" && "attachmentId" in msg) {
      resizes.push({ cols: msg.cols, rows: msg.rows });
      return;
    }
    if (msg.kind === "terminal-input" && "dataBase64" in msg) {
      inputs.push(Buffer.from(msg.dataBase64, "base64").toString("utf8"));
    }
  }

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address();
  if (!addr || typeof addr === "string") throw new Error("mock hub failed to bind");
  const port = addr.port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    resizes,
    inputs,
    get lastOpen() { return lastOpen; },
    get lastTakeControl() { return lastTakeControl; },
    sockets,
    get role() { return role; },
    send,
    sendRebase,
    closeSockets() {
      for (const ws of [...sockets]) ws.close();
    },
    setRole(next) { role = next; },
    close() {
      return new Promise((resolve) => {
        for (const ws of [...sockets]) ws.close();
        wss.close();
        http.close(() => resolve());
      });
    },
  };
}
