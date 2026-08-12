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
