import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // Not a real Node.js server context (e.g., Hono test harness); no socket info.
    return "unknown";
  }
}
