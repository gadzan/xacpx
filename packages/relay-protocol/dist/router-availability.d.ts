/**
 * Wire state for `control.conversations.router.get`.
 *
 * The four statuses stay distinct. `ready` has no reason. Every other status
 * carries a reason whose code is legal only for that status. A boolean is not
 * a value of this type.
 */
export declare const ROUTER_CONFIG_PATH = "conversations.router";
export type RouterUnavailableCode = "restriction-unproven" | "not-advertised";
export type RouterFailedCode = "command-missing" | "auth-missing" | "probe-failed" | "probe-timeout" | "malformed-capabilities" | "read-failed";
export type RouterAvailability = {
    status: "ready";
    configPath: typeof ROUTER_CONFIG_PATH;
} | {
    status: "disabled-by-config";
    configPath: typeof ROUTER_CONFIG_PATH;
    reason: {
        code: "disabled";
        message: string;
    };
} | {
    status: "unsupported";
    configPath: typeof ROUTER_CONFIG_PATH;
    reason: {
        code: RouterUnavailableCode;
        message: string;
    };
} | {
    status: "failed";
    configPath: typeof ROUTER_CONFIG_PATH;
    reason: {
        code: RouterFailedCode;
        message: string;
    };
};
/** Parse a connector payload. Throws when the shape is not one of the four statuses. */
export declare function parseRouterAvailability(value: unknown): RouterAvailability;
