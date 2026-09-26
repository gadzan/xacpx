// Desktop error-code → i18n-key mapping. Lives outside the component so the
// mapping is unit-testable in isolation, and typed against the protocol's
// `DesktopErrorCode` union so a new stable code must be mapped here.
import type { DesktopErrorCode } from "@ganglion/xacpx-relay-protocol";

/**
 * Every stable desktop error code → i18n key. Typed as `Record<DesktopErrorCode,
 * string>` (no index signature, no `?`) so adding a code to the protocol's
 * `DESKTOP_ERROR_CODES` fails typecheck here instead of silently rendering a
 * raw protocol string in the UI.
 */
export const DESKTOP_ERROR_I18N_KEYS: Record<DesktopErrorCode, string> = {
  "desktop-disabled": "desktop.disabled",
  "desktop-busy": "desktop.busy",
  "desktop-rfb-unavailable": "desktop.rfbUnavailable",
  "desktop-not-rfb": "desktop.notRfb",
  "desktop-auth-unsupported": "desktop.authUnsupported",
  "desktop-stream-timeout": "desktop.streamTimeout",
  "desktop-instance-offline": "desktop.offline",
  "desktop-protocol-error": "desktop.errorTitle",
};

/** Codes the browser transport itself can produce (no hub round-trip). */
const TRANSPORT_ERROR_I18N_KEYS: Record<string, string> = {
  "events-offline": "desktop.offline",
};

/** i18n key for a desktop error code, or undefined when unknown. */
export function desktopErrorKey(code: string | undefined): string | undefined {
  if (!code) return undefined;
  // Object.hasOwn, not `in`: a connector-reported code like "toString" or
  // "constructor" would otherwise hit Object.prototype and resolve to a key
  // that is not part of the desktop mapping at all.
  if (Object.hasOwn(DESKTOP_ERROR_I18N_KEYS, code)) {
    return DESKTOP_ERROR_I18N_KEYS[code as DesktopErrorCode];
  }
  return TRANSPORT_ERROR_I18N_KEYS[code];
}
