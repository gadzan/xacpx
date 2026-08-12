# Relay Web RMUX Terminal — process-owned (no rmux patches)

> Date: 2026-08-12  
> Status: active implementation approach  
> Supersedes cross-process adopt/abandon assumptions in the original 2026-08-10 design for the first shippable path.

## Decision

Ship the Relay Web terminal **without modifying `../rmux`**. The connector owns RMUX sessions for the lifetime of the xacpx/sidecar process via `rmux-sdk = "=0.10.0"` `OwnedSession` + `KillOnOwnerExit`.

| Event | Behavior |
|---|---|
| Browser refresh / hub disconnect | Detach viewers only; shell stays |
| Multi-viewer / take-control / rebase | Unchanged |
| Normal xacpx / sidecar stop | Durable `reaping` → explicit kill |
| Hard crash | Daemon reaps within `ownerLeaseTtlSeconds` |
| New process start | **Never adopt**; reap leftover registry / inventory names |

`terminal.enabled` remains default **false**.

## Non-goals

- No `adopt` / `abandon` / fencing APIs against a foreign owner
- No path dependency on workspace `../rmux` or `../acpx`
- No binary UTF-8 bypass at the bridge — browser input is UTF-8 text; illegal UTF-8 is rejected
- No default-on terminal in releases until platform packages + smoke are green

## Components

- Rust sidecar: `packages/channel-relay/native/rmux-bridge`
- Node driver / supervisor / resolver: `packages/channel-relay/src/terminal/rmux-sidecar-*.ts`, `resolve-rmux-binaries.ts`
- Platform optional packages: `@ganglion/xacpx-rmux-bridge-<os>-<arch>` (see `packages/xacpx-rmux-bridge-*`)
- Fake driver for unit/E2E: `in-memory-rmux-driver.ts`
- Opt-in smoke: `tests/smoke/relay-rmux-terminal.test.ts` (`XACPX_RMUX_INTEGRATION=1`)

## Lease TTL wording

`ownerLeaseTtlSeconds` is a **hard-crash cleanup bound**, not a restart-adoption window. Graceful restart must kill before exit; a new process only cleans leftovers.

## Packaging

```bash
cargo build --release --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml
bun run pack:rmux-bridge -- --platform darwin --arch arm64 \
  --binary packages/channel-relay/native/rmux-bridge/target/release/xacpx-rmux-bridge
```

Publish order (enforced by `.github/workflows/publish-channel-relay.yml`):

1. Matrix-build sidecar on linux-x64 / linux-arm64 / darwin-arm64 / darwin-x64 / win32-x64
2. Linux real-daemon smoke (`tests/smoke/relay-rmux-terminal.test.ts`)
3. Publish `@ganglion/xacpx-rmux-bridge-*` optional packages
4. Publish `@ganglion/xacpx-channel-relay`

## Smoke matrix (opt-in)

| Case | Expectation |
|---|---|
| UTF-8 input + recover | first event rebase; kill clears inventory |
| Invalid UTF-8 | `RmuxInvalidUtf8InputError`; session still owned until kill |
| Graceful supervisor stop | session gone for next process (no adopt) |
| resize | stream stays alive |
| `vim` / `top` (when installed) | rebase/bytes; refresh recover still works |
| Multi-viewer recover | single sidecar stream; late subscriber gets cached rebase |
## Related docs

- Original design (lease-adopt oriented): `docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md`
- Plan: `docs/superpowers/plans/2026-08-10-relay-web-rmux-terminal.md`
- Handoff: `docs/superpowers/handoff-2026-08-11-relay-web-rmux-terminal.md`
- Config: `docs/config-reference.md` (`options.terminal`)
- Release: `docs/relay-release.md`
