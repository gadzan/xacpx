# xacpx-rmux-bridge

Process-owned RMUX sidecar for `@ganglion/xacpx-channel-relay`.

- Depends on published `rmux-sdk = "=0.10.0"` (crates.io only — no `../rmux` path dep).
- Does **not** implement cross-process `adopt` / `abandon`. Normal shutdown kills sessions; hard crash relies on RMUX `KillOnOwnerExit` lease TTL.
- Uses a fresh process-scoped RMUX endpoint instead of the user default socket, starts its private daemon lazily, and explicitly shuts it down on clean exit. Production forces an empty RMUX config so user `exit-empty=off` cannot defeat hard-crash retirement after owner leases expire.
- Opt-in real-daemon contract:

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
export RMUX_SDK_DAEMON_BINARY="${RMUX_SDK_DAEMON_BINARY:-$(command -v rmux)}"
# Prefer the full daemon helper when using a release install:
# export RMUX_SDK_DAEMON_BINARY="$HOME/.local/libexec/rmux/rmux"
XACPX_RMUX_INTEGRATION=1 cargo test --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml
```

Build:

```bash
cargo build --release --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml
```
