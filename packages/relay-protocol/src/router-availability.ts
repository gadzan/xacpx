/**
 * Wire state for `control.conversations.router.get`.
 *
 * The four statuses stay distinct. `ready` has no reason. Every other status
 * carries a reason whose code is legal only for that status. A boolean is not
 * a value of this type.
 */

export const ROUTER_CONFIG_PATH = "conversations.router";

export type RouterUnavailableCode = "restriction-unproven" | "not-advertised";

export type RouterFailedCode =
  | "command-missing"
  | "auth-missing"
  | "probe-failed"
  | "probe-timeout"
  | "malformed-capabilities"
  | "read-failed";

export type RouterAvailability =
  | { status: "ready"; configPath: typeof ROUTER_CONFIG_PATH }
  | {
      status: "disabled-by-config";
      configPath: typeof ROUTER_CONFIG_PATH;
      reason: { code: "disabled"; message: string };
    }
  | {
      status: "unsupported";
      configPath: typeof ROUTER_CONFIG_PATH;
      reason: { code: RouterUnavailableCode; message: string };
    }
  | {
      status: "failed";
      configPath: typeof ROUTER_CONFIG_PATH;
      reason: { code: RouterFailedCode; message: string };
    };

const UNAVAILABLE: ReadonlySet<string> = new Set(["restriction-unproven", "not-advertised"]);
const FAILED: ReadonlySet<string> = new Set([
  "command-missing",
  "auth-missing",
  "probe-failed",
  "probe-timeout",
  "malformed-capabilities",
  "read-failed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readReason(value: unknown): { code: string; message: string } | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  const message = value.message.trim();
  if (!message || message.length > 500) return undefined;
  if (Object.keys(value).some((key) => key !== "code" && key !== "message")) return undefined;
  return { code: value.code, message };
}

/** Parse a connector payload. Throws when the shape is not one of the four statuses. */
export function parseRouterAvailability(value: unknown): RouterAvailability {
  if (!isRecord(value) || value.configPath !== ROUTER_CONFIG_PATH) {
    throw new Error("router availability is missing conversations.router");
  }
  const extra = Object.keys(value).filter((key) => key !== "status" && key !== "configPath" && key !== "reason");
  if (extra.length > 0) throw new Error("router availability contains an unsupported field");
  if (value.status === "ready") {
    if ("reason" in value) throw new Error("router availability ready has no reason");
    return { status: "ready", configPath: ROUTER_CONFIG_PATH };
  }
  const reason = readReason(value.reason);
  if (!reason) throw new Error("router availability reason is missing");
  if (value.status === "disabled-by-config" && reason.code === "disabled") {
    return { status: "disabled-by-config", configPath: ROUTER_CONFIG_PATH, reason: { code: "disabled", message: reason.message } };
  }
  if (value.status === "unsupported" && UNAVAILABLE.has(reason.code)) {
    return {
      status: "unsupported",
      configPath: ROUTER_CONFIG_PATH,
      reason: { code: reason.code as RouterUnavailableCode, message: reason.message },
    };
  }
  if (value.status === "failed" && FAILED.has(reason.code)) {
    return {
      status: "failed",
      configPath: ROUTER_CONFIG_PATH,
      reason: { code: reason.code as RouterFailedCode, message: reason.message },
    };
  }
  throw new Error("router availability status is not recognized");
}
