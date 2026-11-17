# @ganglion/xacpx-relay

Self-hosted relay hub for xacpx. Multiple xacpx instances dial out to this
server over WebSocket; accounts log in over HTTP to manage and drive them.

Runtime: Node >= 22.13 (uses node:sqlite) or Bun >= 1.2 (uses bun:sqlite).
One port by default: the HTTP API (default 8787) also serves the dashboard and
the instance WebSocket gateway — the gateway rides the HTTP port's `upgrade`
handler at `/` (or `/gateway`). Pass `--ws-port <n>` only to run the gateway on a
dedicated port instead (the legacy two-port layout).

See `docs/relay-module.md` and the design spec
`docs/superpowers/specs/2026-06-13-relay-hub-design.md` in the repo root.
