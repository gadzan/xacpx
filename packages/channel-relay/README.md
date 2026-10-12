# @ganglion/xacpx-channel-relay

Connector channel plugin: dials out from a local xacpx instance to a
self-hosted @ganglion/xacpx-relay hub over WebSocket.

Requires xacpx >= 0.17.0 (SessionResourceCatalog + plugin-api).

Pairing: `xacpx channel add relay --url ws://<relay-host>:8787 --token <access-token>`.
On first connect the pairing token is exchanged for a long-lived instance
credential stored at `<xacpx-home>/relay/credential.json` (never in config.json).

## RMUX terminal (opt-in)

Terminal support is **off by default**. Enable with:

```json
{
  "id": "relay",
  "type": "relay",
  "options": {
    "url": "wss://relay.example.com",
    "pairingToken": "...",
    "terminal": { "enabled": true }
  }
}
```

Defaults, TTL meanings, and security notes: [`docs/config-reference.md`](../../docs/config-reference.md)
(Relay Channel Configuration). Ops notes: [`docs/relay-deployment.md`](../../docs/relay-deployment.md).

- Tab **X** = global terminate (acked). Closing the browser / network drop only detaches.
- Multi-device share one shell (`controller` / `spectator` + take control).
- Registry/owner under `<xacpx-home>/relay/`; `xacpx doctor` surfaces cleanup-pending read-only.
- Structured logs use `relay.terminal.*` events (IDs/sizes only — never bytes or credentials).

## Instance desktop over RFB/VNC (opt-in)

Watch and control the local graphical desktop of a paired instance from
relay-web. **Off by default** — enabling advertises `desktop.rfb.v1` and
`desktop.ard-auth.v1`. Nothing else about xacpx core changes.

```json
{
  "id": "relay",
  "type": "relay",
  "options": {
    "url": "wss://relay.example.com",
    "pairingToken": "...",
    "desktop": { "enabled": true, "port": 5900 }
  }
}
```

- The target is always `127.0.0.1:<port>` — this connector is **not** a generic
  TCP proxy and never connects to a non-loopback host. That fixes where the
  connector dials; it does not by itself stop the instance's VNC server binding
  `0.0.0.0`. Keeping 5900 unreachable from outside is a deployment requirement
  (loopback-only bind, or loopback-only access control plus firewall) — see the
  platform notes in [`docs/desktop-rfb-setup.md`](../../docs/desktop-rfb-setup.md).
- **Outer VNC Auth (RFB type 2)** and **Apple Remote Desktop (type 30)** are
  accepted. A server that offers both uses VncAuth. `None`, Tight-only,
  VeNCrypt/TLS-only, and proprietary auth are rejected with
  `desktop-auth-unsupported`. macOS Screen Sharing asks for an account name and
  password in the tab; they are sent once and not stored. Single viewer.
- Framebuffer/keyboard/mouse bytes ride an independent binary WebSocket, never
  the control plane or RelayEnvelope.
- Setup, per-platform VNC server notes (TightVNC / TigerVNC / x11vnc / WayVNC)
  and lock-and-UAC limits: [`docs/desktop-rfb-setup.md`](../../docs/desktop-rfb-setup.md)
  (Chinese full reference) and the English
  [`Instance Desktop (RFB/VNC)`](../../packages/docs/guide/relay-self-hosting.md#instance-desktop)
  section of the self-hosting guide.
- Diagnosing a failed open: error codes are stable (`desktop-rfb-unavailable`,
  `desktop-auth-unsupported`, `desktop-busy`, `desktop-not-rfb`, …) and the
  message names the **configured** port, plus the RFB server's own rejection
  text. There is no separate desktop doctor command in Phase A by design.
- Structured logs use `relay.desktop.*` events — hub side `stream_closed`,
  `text_frame`, `oversize_frame`, `backpressure_close`, `preattach_overflow`
  (IDs and reasons only — never RFB bytes or the VNC password).
