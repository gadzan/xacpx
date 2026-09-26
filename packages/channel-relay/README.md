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
relay-web. **Off by default** — enabling advertises `desktop.rfb.v1` and nothing
else about xacpx core changes.

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
  TCP proxy and never connects to a non-loopback host. No public 5900 exposure.
- Only **outer VNC Auth (RFB security type 2)** is accepted in Phase A
  (Linux + Windows, single viewer). `None`, VeNCrypt/TLS-only, proprietary auth,
  and macOS ARD are rejected fail-closed with `desktop-auth-unsupported`.
- Framebuffer/keyboard/mouse bytes ride an independent binary WebSocket, never
  the control plane or RelayEnvelope.
- Setup, per-platform VNC server notes (TightVNC / TigerVNC / x11vnc / WayVNC)
  and lock-and-UAC limits: [`docs/desktop-rfb-setup.md`](../../docs/desktop-rfb-setup.md).
- Structured logs use `relay.desktop.*` events — hub side `stream_closed`,
  `text_frame`, `oversize_frame`, `backpressure_close`, `preattach_overflow`
  (IDs and reasons only — never RFB bytes or the VNC password).
