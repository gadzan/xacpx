# @ganglion/xacpx-channel-relay

Connector channel plugin: dials out from a local xacpx instance to a
self-hosted @ganglion/xacpx-relay hub over WebSocket.

Requires xacpx >= 0.17.0-beta.7 (the first core exposing structured Git/worktree control operations).

Pairing: `xacpx channel add relay --url ws://<relay-host>:8788 --token <pairing-token>`.
On first connect the pairing token is exchanged for a long-lived instance
credential stored at `<xacpx-home>/relay/credential.json` (never in config.json).
