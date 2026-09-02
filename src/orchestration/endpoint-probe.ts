import { createConnection } from "node:net";

/**
 * Liveness probe for an orchestration IPC endpoint (a unix socket or Windows
 * named pipe path). Returns false ONLY when the endpoint definitively has no
 * listener — `ECONNREFUSED` (nothing accepting / stale socket file) or `ENOENT`
 * (pipe/socket path gone) or `ENOTSOCK` (regular file at path, not a socket).
 * A successful connect, or any other / ambiguous error (including a timeout),
 * returns true. This conservative bias means a busy or transiently-unreachable
 * daemon is reported alive, so callers that act on a false result (e.g.
 * self-terminating) do not misfire on a blip.
 *
 * The probe sends no bytes: it connects and immediately closes, which the
 * orchestration server tolerates as an empty connection.
 */
export async function canConnectToEndpoint(path: string, timeoutMs?: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      socket.destroy();
      resolve(result);
    };

    if (timeoutMs !== undefined && timeoutMs > 0) {
      // A connect that neither resolves nor errors within the budget is treated
      // as inconclusive (alive), never as a no-listener.
      timer = setTimeout(() => finish(true), timeoutMs);
      timer.unref?.();
    }
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTSOCK") {
        finish(false);
        return;
      }
      finish(true);
    });
  });
}
