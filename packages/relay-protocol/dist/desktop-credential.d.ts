import type { DesktopCredential } from "./messages.js";
/**
 * The only credential validator: the web `desktop-open` parser, the connector's prepare
 * validator, and the relay-web form all call it. Returns a freshly built object, so a key
 * that a looser caller let through never rides along.
 */
export declare function parseDesktopCredential(value: unknown): DesktopCredential | null;
