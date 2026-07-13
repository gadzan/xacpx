import { parseWebServerEvent, decodeEnvelope, encodeEnvelope, webClientEnvelope, type WebServerEvent, type WebClientMessage } from "@ganglion/xacpx-relay-protocol";

let activeSocket: WebSocket | null = null;

/** Send a browser→hub frame up the live /ws socket. No-op if disconnected. */
export function sendWebClientMessage(msg: WebClientMessage): void {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(encodeEnvelope(webClientEnvelope(msg)));
  }
}

/** Tell the hub which instance(s) this socket is viewing, so it scopes control-events. */
export function sendSubscribe(instanceIds: string[]): void {
  sendWebClientMessage({ kind: "subscribe", instanceIds });
}

/** Connects to the relay /ws fan-out and invokes `onEvent` for each web event. Auto-reconnects. */
export function connectEvents(onEvent: (event: WebServerEvent) => void, onStatus?: (online: boolean) => void): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws`);
    activeSocket = socket;
    socket.onmessage = (e) => {
      const decoded = decodeEnvelope(String(e.data));
      if (!decoded.ok) return;
      const event = parseWebServerEvent(decoded.envelope);
      if (event) onEvent(event);
    };
    socket.onopen = () => { retry = 0; onStatus?.(true); };
    socket.onclose = () => {
      onStatus?.(false);
      activeSocket = null;
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(() => { timer = null; if (!closed) open(); }, 250 * 2 ** (retry - 1));
    };
  };

  open();
  return () => { closed = true; if (timer) { clearTimeout(timer); timer = null; } socket?.close(); };
}
