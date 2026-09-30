// packages/channel-relay/src/desktop/platform-guidance.ts
// Human-readable setup hints surfaced when the loopback RFB probe fails.
// No secrets, no probing side effects: pure message selection for errors.

import type { RfbProbeErrorCode } from "./rfb-probe.js";

export type DesktopPlatform = "win32" | "linux" | "darwin" | string;

export function desktopSetupGuidance(
  platform: DesktopPlatform = process.platform,
  code: RfbProbeErrorCode,
): string {
  if (code === "desktop-rfb-unavailable") {
    if (platform === "win32") {
      // Corrected: the guidance used to say "on 127.0.0.1:5900", but docs/desktop-rfb-setup.md
      // is explicit that loopback-only is a ONE-WAY constraint on the connector's dial, not on
      // the TightVNC bind. The accepted Windows deployment is 0.0.0.0 + LoopbackOnly +
      // firewall, so the old text sent operators chasing a non-existent requirement.
      return "Start TightVNC in the logged-in user session with VNC authentication, and make it accept loopback connections on port 5900 (service sessions show the wrong desktop). Restrict access with TightVNC LoopbackOnly plus the Windows Firewall; binding to 127.0.0.1 is not required.";
    }
    if (platform === "darwin") {
      return "Enable Screen Sharing with a VNC-compatible password, or start a standard VncAuth RFB server reachable on 127.0.0.1:5900.";
    }
    return "Start TigerVNC/x11vnc with VNC authentication so it is reachable on 127.0.0.1:5900. WayVNC needs legacy VncAuth mode (relax_encryption + allow_broken_crypto); default secure WayVNC is rejected.";
  }
  if (code === "desktop-not-rfb") {
    return "The desktop port answered but is not an RFB/VNC server; point options.desktop.port at the loopback VNC server.";
  }
  if (platform === "win32") {
    return "TightVNC must offer outer VNC authentication (type 2); Tight-only endpoints (outer 16 without a type-2 offer) are rejected in v1 because sub-auth can select no-auth. Unauthenticated, VeNCrypt-only, or proprietary-auth servers are rejected.";
  }
  if (platform === "darwin") {
    return "macOS Screen Sharing in ARD-auth mode needs Phase B; configure a standard VncAuth endpoint for Phase A.";
  }
  return "Configure the VNC server for outer VncAuth (type 2); Tight-only (outer 16 without type 2), None, VeNCrypt, and proprietary auth are rejected in v1.";
}
