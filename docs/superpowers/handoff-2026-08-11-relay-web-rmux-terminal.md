# Handoff: Relay Web RMUX Terminal (process-owned, no rmux patches)

> **Date:** 2026-08-12
> **Read first if you are the next agent picking this up.**

Authoritative docs:

- **Process-owned design (active):** `docs/superpowers/specs/2026-08-12-relay-web-rmux-process-owned-design.md`
- Spec (original, lease-adopt oriented): `docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md`
- Plan (original): `docs/superpowers/plans/2026-08-10-relay-web-rmux-terminal.md`

## Scope rules

- Do **not** edit `../rmux` or `../acpx`
- Pin sidecar to crates.io `rmux-sdk = "=0.10.0"`
- **do not push** unless asked
- Do **not** run full `npm run test:smoke` unless asked
- Keep `terminal.enabled` default **false**

## Done

- Process-owned runtime (no adopt/abandon)
- Rust sidecar + Node driver/supervisor/resolver
- Platform package stubs + `pack:rmux-bridge` + publish matrix (build all OS → Linux smoke → publish platforms → publish channel-relay)
- Smoke matrix: UTF-8, shutdown kill, resize, vim/top, multi-viewer fanout
- Multi-viewer fix: one sidecar recover stream + cached rebase for late subscribers

## Local tools

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
bash scripts/install-rmux-release.sh
export RMUX_SDK_DAEMON_BINARY="$HOME/.local/libexec/rmux/rmux"
cargo build --release --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml
export XACPX_RMUX_BRIDGE="$PWD/packages/channel-relay/native/rmux-bridge/target/release/xacpx-rmux-bridge"
export XACPX_RMUX_INTEGRATION=1
bun test tests/smoke/relay-rmux-terminal.test.ts
```
