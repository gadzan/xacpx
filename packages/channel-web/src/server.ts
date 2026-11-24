import { createServer, type Server } from "node:http";

import { getRequestListener } from "@hono/node-server";
import { WebSocketServer } from "ws";

import { createLocalWebApp, SESSION_COOKIE, type LocalWebApp, type LocalWebAppOptions } from "./app.js";
import { hostHeaderAllowed, originAllowed } from "./security.js";

export interface LocalWebServer {
  port: number;
  local: LocalWebApp;
  close: () => Promise<void>;
}

export async function startLocalWebServer(options: LocalWebAppOptions): Promise<LocalWebServer> {
  const local = createLocalWebApp(options);
  const server = createServer(getRequestListener(local.app.fetch));
  const sockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const host = request.headers.host;
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const session = cookieValue(request.headers.cookie, SESSION_COOKIE);
    if (url.pathname !== "/ws"
      || !hostHeaderAllowed(host, options.config.host, local.ports.current)
      || !originAllowed(origin, options.config.host, local.ports.current)
      || !local.allows(session)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const onClient = local.attach(
        (data, done) => {
          if (ws.readyState !== ws.OPEN) {
            done?.(new Error("socket-closed"));
            return;
          }
          ws.send(data, (error) => done?.(error ?? undefined));
        },
        () => ws.close(),
        session,
      );
      ws.on("message", (data) => onClient(String(data)));
      ws.on("close", () => onClient());
    });
  });

  await listen(server, options.config.host, options.config.port);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.config.port;
  local.ports.current = port;
  return {
    port,
    local,
    close: () => new Promise((resolve) => {
      local.close();
      for (const client of sockets.clients) client.close();
      sockets.close();
      server.close(() => resolve());
    }),
  };
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
